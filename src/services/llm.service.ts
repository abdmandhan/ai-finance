import type { Config, ILogger } from "@/commons";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  createAgent,
  providerStrategy,
  StructuredOutputParsingError,
  toolStrategy,
} from "langchain";
import { initChatModel } from "langchain/chat_models/universal";
import type { z } from "zod";
import type {
  ILlmPricingService,
  LlmCostEstimate,
  LlmUsage,
} from "./llm-pricing.service";
import type {
  IProcessLogService,
  ProcessLogLlmMetrics,
} from "./process-log.service";

export type ModelSize = "small" | "medium" | "large";

export interface InvokeOptions<
  Schema extends z.ZodType | undefined = undefined,
> {
  tools?: StructuredToolInterface[];
  responseFormat?: Schema;
}

export interface AgentResult<Schema extends z.ZodType | undefined = undefined> {
  messages: BaseMessage[];
  structuredResponse?: Schema extends z.ZodType
    ? z.infer<Schema>
    : Record<string, unknown>;
  lastMessage: AIMessage;
}

/**
 * Tiered chat models behind one interface. Nodes depend on this interface, not
 * on a concrete provider, so providers/models swap via config without touching
 * graphs. `invoke` carries the full structured-output fallback ladder;
 * `extract`/`chat` are the node-facing conveniences built on top of it.
 */
export interface ILlmService {
  invoke<Schema extends z.ZodType | undefined = undefined>(
    modelSize: ModelSize,
    messages: BaseMessage[] | string,
    options?: InvokeOptions<Schema>,
  ): Promise<AgentResult<Schema>>;
  /** Invoke the model and coerce the reply into `schema`; throws when the ladder exhausts. */
  extract<T extends Record<string, any>>(
    schema: z.ZodType<T>,
    messages: BaseMessage[],
    name: string,
    size?: ModelSize,
  ): Promise<T>;
  /**
   * Plain chat turn; binds `tools` when provided. Returns the raw AIMessage,
   * which may carry `tool_calls` for the caller to execute.
   */
  chat(
    messages: BaseMessage[],
    options?: { tools?: StructuredToolInterface[]; size?: ModelSize },
  ): Promise<AIMessage>;
}

interface ResolvedModelConfig {
  url: string;
  apiKey: string;
  model: string;
  provider: string;
  modelName: string;
}

function resolveModelConfig(
  llm: Config["llm"],
  size: ModelSize,
): ResolvedModelConfig {
  const variant = llm[size];
  const [provider, ...rest] = variant.model.split(":");
  const modelName = rest.join(":");
  return {
    url: variant.url || llm.url,
    apiKey: variant.api_key || llm.api_key || "no-key",
    model: variant.model,
    provider,
    modelName,
  };
}

type UniversalModel = Awaited<ReturnType<typeof initChatModel>>;

export class LlmService implements ILlmService {
  private models: Partial<Record<ModelSize, UniversalModel>> = {};
  private modelConfigs: Partial<Record<ModelSize, ResolvedModelConfig>> = {};
  private initialized = false;

  constructor(
    private readonly config: Config["llm"],
    private readonly logger: ILogger,
    private readonly processLog?: IProcessLogService,
    private readonly pricing?: ILlmPricingService,
  ) {
    this.logger = logger.child({ service: "LlmService" });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const initOne = (size: ModelSize) => {
      const resolved = resolveModelConfig(this.config, size);
      this.modelConfigs[size] = resolved;
      return initChatModel(resolved.modelName, {
        apiKey: resolved.apiKey,
        modelProvider: resolved.provider,
        // baseURL is OpenAI-compatible only; hosted providers reject it.
        ...(resolved.url ? { configuration: { baseURL: resolved.url } } : {}),
        // Some GPT-5 reasoning models only accept the default temperature.
        ...(resolved.provider === "openai" ? {} : { temperature: 0.1 }),
      });
    };

    const [small, medium, large] = await Promise.all([
      initOne("small"),
      initOne("medium"),
      initOne("large"),
    ]);

    this.models = { small, medium, large };
    this.initialized = true;
  }

  async invoke<Schema extends z.ZodType | undefined = undefined>(
    modelSize: ModelSize,
    messages: BaseMessage[] | string,
    options?: InvokeOptions<Schema>,
  ): Promise<AgentResult<Schema>> {
    await this.ensureInitialized();

    const model = this.models[modelSize];
    const modelConfig = this.modelConfigs[modelSize]!;
    if (!model) {
      throw new Error(`Unknown model size: ${modelSize}`);
    }

    const agent = createAgent({
      model,
      tools: options?.tools ?? [],
      ...(options?.responseFormat
        ? { responseFormat: providerStrategy(options.responseFormat) }
        : {}),
    });

    const agentMessages =
      typeof messages === "string" ? [new HumanMessage(messages)] : messages;
    const finalMessages = mergeSystemMessages(agentMessages);
    const started = Date.now();
    this.processLog?.log({
      event: "assistant.model_call",
      stage: "llm.invoke.start",
      tool: "llm.invoke",
      payload: {
        modelSize,
        provider: modelConfig.provider,
        model: modelConfig.modelName,
        modelKey: modelConfig.model,
        messageCount: finalMessages.length,
        toolNames: options?.tools?.map((t) => t.name) ?? [],
        responseFormat: Boolean(options?.responseFormat),
        messages: describeMessages(finalMessages),
      },
    });

    let result: Awaited<ReturnType<typeof agent.invoke>>;
    try {
      result = await agent.invoke({ messages: finalMessages });
    } catch (err) {
      // TypeError (e.g. "Cannot read properties of undefined (reading 'message')")
      // means the model returned a malformed/empty response. This is NOT transient —
      // retrying won't help. Return a soft error so callers handle it gracefully
      // via their structuredResponse checks.
      if (err instanceof TypeError) {
        this.logger.error({ err }, "LLM invocation failed with TypeError");
        this.processLog?.log({
          event: "assistant.model_call",
          stage: "llm.invoke.end",
          tool: "llm.invoke",
          status: "type_error",
          durationMs: Date.now() - started,
          payload: {
            modelSize,
            provider: modelConfig.provider,
            model: modelConfig.modelName,
            modelKey: modelConfig.model,
          },
          error: err,
        });
        return {
          messages: [],
          structuredResponse: undefined,
          lastMessage: new AIMessage(`LLM invocation failed: ${err.message}`),
        };
      } else if (err instanceof StructuredOutputParsingError) {
        // Structured output parsing failed — retry with toolStrategy which
        // forces structured output via a synthetic tool call.
        this.processLog?.log({
          event: "assistant.model_call",
          stage: "llm.invoke.retry_tool_strategy",
          tool: "llm.invoke",
          status: "retry",
          durationMs: Date.now() - started,
          error: err,
        });
        const retry = await this.invokeWithToolStrategy(
          model,
          finalMessages,
          options,
        );
        const usage = usageFromMessages(retry.messages);
        const cost = await this.estimateCost(modelConfig, usage);
        this.processLog?.log({
          event: "assistant.model_call",
          stage: "llm.invoke.end",
          tool: "llm.invoke",
          status: retry.structuredResponse ? "ok" : "no_structured_response",
          durationMs: Date.now() - started,
          payload: {
            modelSize,
            provider: modelConfig.provider,
            model: modelConfig.modelName,
            modelKey: modelConfig.model,
            usage,
            cost,
            structuredResponse: retry.structuredResponse,
            lastMessage: describeMessage(retry.lastMessage),
          },
          llm: buildLlmMetrics(modelConfig, modelSize, usage, cost),
        });
        return retry;
      } else {
        // Other errors (network, auth, rate-limit) — rethrow so callers retry.
        this.processLog?.log({
          event: "assistant.model_call",
          stage: "llm.invoke.error",
          tool: "llm.invoke",
          status: "error",
          durationMs: Date.now() - started,
          payload: {
            modelSize,
            provider: modelConfig.provider,
            model: modelConfig.modelName,
            modelKey: modelConfig.model,
          },
          error: err,
        });
        throw err;
      }
    }

    // createAgent always returns AIMessage as last message
    let lastAiMessage = result.messages[
      result.messages.length - 1
    ] as AIMessage;
    let structuredResponse = (
      result as { structuredResponse?: Record<string, unknown> }
    ).structuredResponse as AgentResult<Schema>["structuredResponse"];

    // Fallback: retry agent with toolStrategy, which forces structured output
    // via a synthetic tool call
    let fallbackUsage: LlmUsage | undefined;
    if (!structuredResponse && options?.responseFormat) {
      try {
        const toolAgent = createAgent({
          model,
          responseFormat: toolStrategy(options.responseFormat) as any,
        });
        const toolResult = await toolAgent.invoke({
          messages: result.messages,
        });
        const toolLastMsg = toolResult.messages[
          toolResult.messages.length - 1
        ] as AIMessage;
        structuredResponse =
          toolResult.structuredResponse as AgentResult<Schema>["structuredResponse"];
        if (structuredResponse) {
          lastAiMessage = toolLastMsg;
          fallbackUsage = usageFromMessages(
            toolResult.messages.slice(result.messages.length),
          );
        }
      } catch {
        // toolStrategy fallback failed; structuredResponse stays undefined
      }
    }

    const usage = sumUsages([
      usageFromMessages(result.messages),
      fallbackUsage,
    ]);
    const cost = await this.estimateCost(modelConfig, usage);
    const out = {
      messages: result.messages,
      structuredResponse,
      lastMessage: lastAiMessage,
    };
    this.processLog?.log({
      event: "assistant.model_call",
      stage: "llm.invoke.end",
      tool: "llm.invoke",
      status: structuredResponse ? "ok" : "no_structured_response",
      durationMs: Date.now() - started,
      payload: {
        modelSize,
        provider: modelConfig.provider,
        model: modelConfig.modelName,
        modelKey: modelConfig.model,
        usage,
        cost,
        structuredResponse,
        lastMessage: describeMessage(lastAiMessage),
        messageCount: result.messages.length,
      },
      llm: buildLlmMetrics(modelConfig, modelSize, usage, cost),
    });
    return out;
  }

  async extract<T extends Record<string, any>>(
    schema: z.ZodType<T>,
    messages: BaseMessage[],
    name: string,
    size: ModelSize = "medium",
  ): Promise<T> {
    const result = await this.invoke(size, messages, {
      responseFormat: schema,
    });
    if (!result.structuredResponse) {
      throw new Error(
        `extract "${name}" produced no structured output: ${result.lastMessage.text}`,
      );
    }
    return result.structuredResponse as T;
  }

  async chat(
    messages: BaseMessage[],
    options?: { tools?: StructuredToolInterface[]; size?: ModelSize },
  ): Promise<AIMessage> {
    await this.ensureInitialized();
    const size = options?.size ?? "large";
    const model = this.models[size]!;
    const modelConfig = this.modelConfigs[size]!;
    const finalMessages = mergeSystemMessages(messages);
    const runnable = options?.tools?.length
      ? model.bindTools(options.tools)
      : model;
    const started = Date.now();
    this.processLog?.log({
      event: "assistant.model_call",
      stage: "llm.chat.start",
      tool: "llm.chat",
      payload: {
        modelSize: size,
        provider: modelConfig.provider,
        model: modelConfig.modelName,
        modelKey: modelConfig.model,
        messageCount: finalMessages.length,
        toolNames: options?.tools?.map((t) => t.name) ?? [],
        messages: describeMessages(finalMessages),
      },
    });
    try {
      const response = (await runnable.invoke(finalMessages)) as AIMessage;
      const usage = usageFromMessage(response);
      const cost = await this.estimateCost(modelConfig, usage);
      this.processLog?.log({
        event: "assistant.model_call",
        stage: "llm.chat.end",
        tool: "llm.chat",
        status: "ok",
        durationMs: Date.now() - started,
        payload: {
          modelSize: size,
          provider: modelConfig.provider,
          model: modelConfig.modelName,
          modelKey: modelConfig.model,
          usage,
          cost,
          response: describeMessage(response),
        },
        llm: buildLlmMetrics(modelConfig, size, usage, cost),
      });
      return response;
    } catch (error) {
      this.processLog?.log({
        event: "assistant.model_call",
        stage: "llm.chat.error",
        tool: "llm.chat",
        status: "error",
        durationMs: Date.now() - started,
        payload: {
          modelSize: size,
          provider: modelConfig.provider,
          model: modelConfig.modelName,
          modelKey: modelConfig.model,
        },
        error,
      });
      throw error;
    }
  }

  private async invokeWithToolStrategy<
    Schema extends z.ZodType | undefined = undefined,
  >(
    model: UniversalModel,
    messages: BaseMessage[],
    options: InvokeOptions<Schema> | undefined,
  ): Promise<AgentResult<Schema>> {
    try {
      const toolAgent = createAgent({
        model,
        responseFormat: toolStrategy(options!.responseFormat!) as any,
      });
      const toolResult = await toolAgent.invoke({ messages });
      const toolLastMsg = toolResult.messages[
        toolResult.messages.length - 1
      ] as AIMessage;
      const structuredResponse =
        toolResult.structuredResponse as AgentResult<Schema>["structuredResponse"];
      return {
        messages: toolResult.messages,
        structuredResponse,
        lastMessage: toolLastMsg,
      };
    } catch {
      return {
        messages,
        structuredResponse: undefined,
        lastMessage: messages[messages.length - 1] as AIMessage,
      };
    }
  }

  private async estimateCost(
    modelConfig: ResolvedModelConfig,
    usage: LlmUsage | undefined,
  ): Promise<LlmCostEstimate | { status: "missing_price" } | undefined> {
    return this.pricing?.estimateCost({
      provider: modelConfig.provider,
      model: modelConfig.modelName,
      usage,
    });
  }
}

function buildLlmMetrics(
  modelConfig: ResolvedModelConfig,
  modelSize: ModelSize,
  usage: LlmUsage | undefined,
  cost: LlmCostEstimate | { status: "missing_price" } | undefined,
): ProcessLogLlmMetrics | undefined {
  if (!usage) return undefined;
  const metrics: ProcessLogLlmMetrics = {
    provider: modelConfig.provider,
    model: modelConfig.modelName,
    modelKey: modelConfig.model,
    modelSize,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
  if (!cost) return metrics;
  if ("status" in cost) {
    metrics.costStatus = cost.status;
    return metrics;
  }
  metrics.costEstimated = cost.estimated;
  metrics.costCurrency = cost.currency;
  metrics.priceId = cost.priceId;
  metrics.processingTier = cost.processingTier;
  metrics.contextTier = cost.contextTier;
  metrics.costStatus = "estimated";
  return metrics;
}

/**
 * Anthropic permits only ONE system message and it must be first. Callers may
 * pass several system prompts, so merge every system message into a single
 * leading system message and keep the rest in order.
 */
function mergeSystemMessages(messages: BaseMessage[]): BaseMessage[] {
  const systemText = messages
    .filter((m) => m instanceof SystemMessage)
    .map((m) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
  const nonSystem = messages.filter((m) => !(m instanceof SystemMessage));
  return systemText ? [new SystemMessage(systemText), ...nonSystem] : nonSystem;
}

function describeMessage(message: BaseMessage): unknown {
  return {
    type: message.getType(),
    content: message.content,
    toolCalls:
      message instanceof AIMessage
        ? message.tool_calls?.map((call) => ({
            name: call.name,
            args: call.args,
            id: call.id,
          }))
        : undefined,
  };
}

function describeMessages(messages: BaseMessage[]): unknown[] {
  return messages.map((message) => describeMessage(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nestedNum(
  value: unknown,
  ...path: string[]
): number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return num(current);
}

export function usageFromMessage(message: BaseMessage): LlmUsage | undefined {
  if (!(message instanceof AIMessage)) return undefined;
  const candidate = message as unknown as {
    usage_metadata?: unknown;
    response_metadata?: unknown;
  };
  const usageMetadata = candidate.usage_metadata;
  const responseMetadata = candidate.response_metadata;
  const tokenUsage = isRecord(responseMetadata)
    ? responseMetadata.tokenUsage
    : undefined;
  const responseUsage = isRecord(responseMetadata)
    ? responseMetadata.usage
    : undefined;

  const inputTokens =
    nestedNum(usageMetadata, "input_tokens") ??
    nestedNum(usageMetadata, "inputTokens") ??
    nestedNum(tokenUsage, "promptTokens") ??
    nestedNum(tokenUsage, "prompt_tokens") ??
    nestedNum(responseUsage, "prompt_tokens") ??
    nestedNum(responseUsage, "input_tokens");
  const outputTokens =
    nestedNum(usageMetadata, "output_tokens") ??
    nestedNum(usageMetadata, "outputTokens") ??
    nestedNum(tokenUsage, "completionTokens") ??
    nestedNum(tokenUsage, "completion_tokens") ??
    nestedNum(responseUsage, "completion_tokens") ??
    nestedNum(responseUsage, "output_tokens");
  const totalTokens =
    nestedNum(usageMetadata, "total_tokens") ??
    nestedNum(usageMetadata, "totalTokens") ??
    nestedNum(tokenUsage, "totalTokens") ??
    nestedNum(tokenUsage, "total_tokens") ??
    nestedNum(responseUsage, "total_tokens");
  const cachedInputTokens =
    nestedNum(usageMetadata, "input_token_details", "cache_read") ??
    nestedNum(usageMetadata, "input_token_details", "cached_tokens") ??
    nestedNum(usageMetadata, "inputTokenDetails", "cacheRead") ??
    nestedNum(responseUsage, "prompt_tokens_details", "cached_tokens");
  const cacheWriteTokens =
    nestedNum(usageMetadata, "input_token_details", "cache_creation") ??
    nestedNum(usageMetadata, "inputTokenDetails", "cacheCreation");

  const usage: LlmUsage = {
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens,
  };
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

function usageFromMessages(messages: BaseMessage[]): LlmUsage | undefined {
  return sumUsages(messages.map((message) => usageFromMessage(message)));
}

function sumUsages(usages: (LlmUsage | undefined)[]): LlmUsage | undefined {
  const out: LlmUsage = {};
  for (const usage of usages) {
    if (!usage) continue;
    out.inputTokens = add(out.inputTokens, usage.inputTokens);
    out.cachedInputTokens = add(
      out.cachedInputTokens,
      usage.cachedInputTokens,
    );
    out.cacheWriteTokens = add(out.cacheWriteTokens, usage.cacheWriteTokens);
    out.outputTokens = add(out.outputTokens, usage.outputTokens);
    out.totalTokens = add(out.totalTokens, usage.totalTokens);
  }
  return Object.values(out).some((value) => value !== undefined)
    ? out
    : undefined;
}

function add(a: number | undefined, b: number | undefined): number | undefined {
  if (b === undefined) return a;
  return (a ?? 0) + b;
}

export function createLlmService(
  config: Config["llm"],
  logger: ILogger,
  processLog?: IProcessLogService,
  pricing?: ILlmPricingService,
): ILlmService {
  return new LlmService(config, logger, processLog, pricing);
}
