import type { Config } from "@/commons";
import { configUtils } from "@/commons";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const initChatModel = vi.fn();
vi.mock("langchain/chat_models/universal", () => ({
  initChatModel: (...args: unknown[]) => initChatModel(...args),
}));

const createAgent = vi.fn();
const providerStrategy = vi.fn((schema: unknown) => ({
  kind: "provider",
  schema,
}));
const toolStrategy = vi.fn((schema: unknown) => ({ kind: "tool", schema }));
class StructuredOutputParsingError extends Error {}
vi.mock("langchain", () => ({
  createAgent: (...args: unknown[]) => createAgent(...args),
  providerStrategy: (schema: unknown) => providerStrategy(schema),
  toolStrategy: (schema: unknown) => toolStrategy(schema),
  get StructuredOutputParsingError() {
    return StructuredOutputParsingError;
  },
}));

import { createLlmService, LlmService, usageFromMessage } from "./llm.service";

const logger = pino({ level: "silent" });
const schema = z.object({ answer: z.string() });

function makeLlmConfig(over: Partial<Config["llm"]> = {}): Config["llm"] {
  const config = configUtils.configSchema.parse({ kafka: {} });
  return { ...config.llm, api_key: "shared-key", ...over };
}

function makeModel() {
  return {
    invoke: vi.fn(async () => new AIMessage("plain reply")),
    bindTools: vi.fn(function (this: unknown) {
      return { invoke: vi.fn(async () => new AIMessage("tool reply")) };
    }),
  };
}

function makeProcessLog() {
  return {
    log: vi.fn(),
  };
}

function makePricing() {
  return {
    lookup: vi.fn(),
    close: vi.fn(),
    estimateCost: vi.fn(async () => ({
      estimated: 0.001065,
      currency: "USD",
      priceId: "42",
      processingTier: "standard",
      contextTier: "short",
    })),
  };
}

function makeMissingPricePricing() {
  return {
    lookup: vi.fn(),
    close: vi.fn(),
    estimateCost: vi.fn(async () => ({ status: "missing_price" })),
  };
}

beforeEach(() => {
  initChatModel.mockReset();
  createAgent.mockReset();
  initChatModel.mockImplementation(async () => makeModel());
});

describe("LlmService model initialization", () => {
  it("initializes all three tiers from provider:model strings with shared key fallback", async () => {
    const service = createLlmService(
      makeLlmConfig({
        small: { url: "", api_key: "tier-key", model: "openai:gpt-4o-mini" },
      }),
      logger,
    );
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => ({ messages: [new AIMessage("hi")] })),
    });

    await service.invoke("small", "hello");

    expect(initChatModel).toHaveBeenCalledTimes(3);
    const bySize = Object.fromEntries(
      initChatModel.mock.calls.map((c) => [c[0], c[1]]),
    );
    // small: openai tier — own key, no temperature (GPT-5 reasoning caveat)
    expect(bySize["gpt-4o-mini"].apiKey).toBe("tier-key");
    expect(bySize["gpt-4o-mini"].modelProvider).toBe("openai");
    expect(bySize["gpt-4o-mini"].temperature).toBeUndefined();
    // medium/large: anthropic defaults — shared key, temperature set
    expect(bySize["claude-sonnet-4-5-20250929"].apiKey).toBe("shared-key");
    expect(bySize["claude-sonnet-4-5-20250929"].modelProvider).toBe(
      "anthropic",
    );
    expect(bySize["claude-sonnet-4-5-20250929"].temperature).toBe(0.1);
    // no baseURL configured → no configuration block
    expect(bySize["gpt-4o-mini"].configuration).toBeUndefined();
  });
});

describe("LlmService.invoke structured-output ladder", () => {
  it("returns provider-strategy structured output on the happy path", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => ({
        messages: [new AIMessage("done")],
        structuredResponse: { answer: "42" },
      })),
    });

    const result = await service.invoke("medium", [new HumanMessage("q")], {
      responseFormat: schema,
    });

    expect(result.structuredResponse).toEqual({ answer: "42" });
    expect(providerStrategy).toHaveBeenCalledWith(schema);
  });

  it("merges all system messages into one leading system message", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    const agentInvoke = vi.fn(
      async (_input: { messages: (SystemMessage | HumanMessage)[] }) => ({
        messages: [new AIMessage("ok")],
      }),
    );
    createAgent.mockReturnValue({ invoke: agentInvoke });

    await service.invoke("medium", [
      new SystemMessage("first"),
      new HumanMessage("hi"),
      new SystemMessage("second"),
    ]);

    const sent = agentInvoke.mock.calls[0][0].messages;
    expect(sent[0]).toBeInstanceOf(SystemMessage);
    expect(sent[0].content).toBe("first\n\nsecond");
    expect(
      sent.filter((m: unknown) => m instanceof SystemMessage),
    ).toHaveLength(1);
  });

  it("retries with toolStrategy on StructuredOutputParsingError", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent
      .mockReturnValueOnce({
        invoke: vi.fn(async () => {
          throw new StructuredOutputParsingError("parse fail");
        }),
      })
      .mockReturnValueOnce({
        invoke: vi.fn(async () => ({
          messages: [new AIMessage("via tool")],
          structuredResponse: { answer: "tooled" },
        })),
      });

    const result = await service.invoke("medium", "q", {
      responseFormat: schema,
    });

    expect(result.structuredResponse).toEqual({ answer: "tooled" });
    expect(toolStrategy).toHaveBeenCalledWith(schema);
  });

  it("soft-fails on TypeError without throwing", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => {
        throw new TypeError("cannot read properties of undefined");
      }),
    });

    const result = await service.invoke("medium", "q", {
      responseFormat: schema,
    });

    expect(result.structuredResponse).toBeUndefined();
    expect(result.lastMessage.content).toContain("LLM invocation failed");
  });

  it("rethrows other errors (network/auth/rate-limit)", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });

    await expect(service.invoke("medium", "q")).rejects.toThrow("rate limited");
  });

  it("falls back to toolStrategy when structuredResponse is missing post-hoc", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent
      .mockReturnValueOnce({
        invoke: vi.fn(async () => ({
          messages: [new AIMessage("no structure")],
        })),
      })
      .mockReturnValueOnce({
        invoke: vi.fn(async () => ({
          messages: [new AIMessage("structured now")],
          structuredResponse: { answer: "recovered" },
        })),
      });

    const result = await service.invoke("medium", "q", {
      responseFormat: schema,
    });

    expect(result.structuredResponse).toEqual({ answer: "recovered" });
  });
});

describe("LlmService.extract / chat", () => {
  it("extract returns the structured response", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => ({
        messages: [new AIMessage("ok")],
        structuredResponse: { answer: "x" },
      })),
    });

    await expect(
      service.extract(schema, [new HumanMessage("q")], "test"),
    ).resolves.toEqual({ answer: "x" });
  });

  it("extract throws a descriptive error when the ladder exhausts", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => {
        throw new TypeError("malformed");
      }),
    });

    await expect(
      service.extract(schema, [new HumanMessage("q")], "workflow"),
    ).rejects.toThrow(/extract "workflow" produced no structured output/);
  });

  it("chat binds tools when provided and merges system messages", async () => {
    const service = new LlmService(makeLlmConfig(), logger);
    createAgent.mockReturnValue({ invoke: vi.fn() });

    const reply = await service.chat(
      [new SystemMessage("sys"), new HumanMessage("hi")],
      { tools: [{ name: "t" } as never] },
    );

    expect(reply.content).toBe("tool reply");
  });

  it("logs chat token usage and estimated cost", async () => {
    const response = Object.assign(new AIMessage("priced reply"), {
      usage_metadata: {
        input_tokens: 1_000,
        output_tokens: 100,
        total_tokens: 1_100,
        input_token_details: { cache_read: 200 },
      },
    });
    initChatModel.mockImplementation(async () => ({
      invoke: vi.fn(async () => response),
      bindTools: vi.fn(),
    }));
    const processLog = makeProcessLog();
    const pricing = makePricing();
    const service = new LlmService(
      makeLlmConfig({
        large: { url: "", api_key: "", model: "openai:gpt-5.4-mini" },
      }),
      logger,
      processLog as never,
      pricing as never,
    );

    await service.chat([new HumanMessage("hi")]);

    expect(pricing.estimateCost).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        cacheWriteTokens: undefined,
        outputTokens: 100,
        totalTokens: 1_100,
      },
    });
    expect(processLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "llm.chat.end",
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          modelKey: "openai:gpt-5.4-mini",
          modelSize: "large",
          inputTokens: 1_000,
          cachedInputTokens: 200,
          cacheWriteTokens: undefined,
          outputTokens: 100,
          totalTokens: 1_100,
          costEstimated: 0.001065,
          costCurrency: "USD",
          priceId: "42",
          processingTier: "standard",
          contextTier: "short",
          costStatus: "estimated",
        },
        payload: expect.objectContaining({
          modelSize: "large",
          provider: "openai",
          model: "gpt-5.4-mini",
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            cacheWriteTokens: undefined,
            outputTokens: 100,
            totalTokens: 1_100,
          },
          cost: expect.objectContaining({
            estimated: 0.001065,
            priceId: "42",
          }),
        }),
      }),
    );
  });

  it("logs missing-price status in typed LLM metrics", async () => {
    const response = Object.assign(new AIMessage("unpriced reply"), {
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
      },
    });
    initChatModel.mockImplementation(async () => ({
      invoke: vi.fn(async () => response),
      bindTools: vi.fn(),
    }));
    const processLog = makeProcessLog();
    const pricing = makeMissingPricePricing();
    const service = new LlmService(
      makeLlmConfig({
        large: { url: "", api_key: "", model: "openai:unknown-model" },
      }),
      logger,
      processLog as never,
      pricing as never,
    );

    await service.chat([new HumanMessage("hi")]);

    expect(processLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "llm.chat.end",
        llm: expect.objectContaining({
          provider: "openai",
          model: "unknown-model",
          modelSize: "large",
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          costStatus: "missing_price",
        }),
        payload: expect.objectContaining({
          cost: { status: "missing_price" },
        }),
      }),
    );
  });
});

describe("LLM usage metadata extraction", () => {
  it("extracts OpenAI-style response metadata", () => {
    const message = Object.assign(new AIMessage("ok"), {
      response_metadata: {
        tokenUsage: {
          promptTokens: 300,
          completionTokens: 40,
          totalTokens: 340,
        },
      },
    });

    expect(usageFromMessage(message)).toEqual({
      inputTokens: 300,
      cachedInputTokens: undefined,
      cacheWriteTokens: undefined,
      outputTokens: 40,
      totalTokens: 340,
    });
  });
});

describe("LlmService process-log usage", () => {
  it("logs invoke token usage and estimated cost", async () => {
    const processLog = makeProcessLog();
    const pricing = makePricing();
    const service = new LlmService(
      makeLlmConfig({
        medium: { url: "", api_key: "", model: "openai:gpt-5.4-mini" },
      }),
      logger,
      processLog as never,
      pricing as never,
    );
    const response = Object.assign(new AIMessage("done"), {
      response_metadata: {
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 100,
          total_tokens: 1_100,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      },
    });
    createAgent.mockReturnValue({
      invoke: vi.fn(async () => ({
        messages: [response],
        structuredResponse: { answer: "42" },
      })),
    });

    await service.invoke("medium", [new HumanMessage("q")], {
      responseFormat: schema,
    });

    expect(processLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "llm.invoke.end",
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          modelKey: "openai:gpt-5.4-mini",
          modelSize: "medium",
          inputTokens: 1_000,
          cachedInputTokens: 200,
          cacheWriteTokens: undefined,
          outputTokens: 100,
          totalTokens: 1_100,
          costEstimated: 0.001065,
          costCurrency: "USD",
          priceId: "42",
          processingTier: "standard",
          contextTier: "short",
          costStatus: "estimated",
        },
        payload: expect.objectContaining({
          modelSize: "medium",
          provider: "openai",
          model: "gpt-5.4-mini",
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 200,
            cacheWriteTokens: undefined,
            outputTokens: 100,
            totalTokens: 1_100,
          },
          cost: expect.objectContaining({
            estimated: 0.001065,
            currency: "USD",
          }),
        }),
      }),
    );
  });
});
