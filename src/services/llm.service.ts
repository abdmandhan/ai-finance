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
}

function resolveModelConfig(
  llm: Config["llm"],
  size: ModelSize,
): ResolvedModelConfig {
  const variant = llm[size];
  return {
    url: variant.url || llm.url,
    apiKey: variant.api_key || llm.api_key || "no-key",
    model: variant.model,
  };
}

type UniversalModel = Awaited<ReturnType<typeof initChatModel>>;

export class LlmService implements ILlmService {
  private models: Partial<Record<ModelSize, UniversalModel>> = {};
  private initialized = false;

  constructor(
    private readonly config: Config["llm"],
    private readonly logger: ILogger,
  ) {
    this.logger = logger.child({ service: "LlmService" });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const initOne = (size: ModelSize) => {
      const { url, apiKey, model } = resolveModelConfig(this.config, size);
      const [provider, ...rest] = model.split(":");
      const modelName = rest.join(":");
      return initChatModel(modelName, {
        apiKey,
        modelProvider: provider,
        // baseURL is OpenAI-compatible only; hosted providers reject it.
        ...(url ? { configuration: { baseURL: url } } : {}),
        // Some GPT-5 reasoning models only accept the default temperature.
        ...(provider === "openai" ? {} : { temperature: 0.1 }),
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
        return {
          messages: [],
          structuredResponse: undefined,
          lastMessage: new AIMessage(`LLM invocation failed: ${err.message}`),
        };
      } else if (err instanceof StructuredOutputParsingError) {
        // Structured output parsing failed — retry with toolStrategy which
        // forces structured output via a synthetic tool call.
        return this.invokeWithToolStrategy(model, finalMessages, options);
      } else {
        // Other errors (network, auth, rate-limit) — rethrow so callers retry.
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
        }
      } catch {
        // toolStrategy fallback failed; structuredResponse stays undefined
      }
    }

    return {
      messages: result.messages,
      structuredResponse,
      lastMessage: lastAiMessage,
    };
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
    const model = this.models[options?.size ?? "large"]!;
    const finalMessages = mergeSystemMessages(messages);
    const runnable = options?.tools?.length
      ? model.bindTools(options.tools)
      : model;
    return (await runnable.invoke(finalMessages)) as AIMessage;
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

export function createLlmService(
  config: Config["llm"],
  logger: ILogger,
): ILlmService {
  return new LlmService(config, logger);
}
