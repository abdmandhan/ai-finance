import type { ILogger } from "@/commons";
import { describe, expect, it, vi } from "vitest";
import {
  calculateLlmCost,
  LlmPricingService,
  type LlmModelPrice,
} from "./llm-pricing.service";
import type { ProcessLogPool } from "./process-log.service";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  } as unknown as ILogger;
}

function pool(query: ProcessLogPool["query"]): ProcessLogPool {
  return {
    query,
    end: vi.fn(async () => {}),
  };
}

const gpt54MiniStandard: LlmModelPrice = {
  id: "42",
  provider: "openai",
  model: "gpt-5.4-mini",
  processingTier: "standard",
  contextTier: "short",
  currency: "USD",
  inputPerMillion: 0.75,
  cachedInputPerMillion: 0.075,
  outputPerMillion: 4.5,
  sourceUrl: "https://developers.openai.com/api/docs/pricing",
};

describe("LlmPricingService", () => {
  it("looks up the active default standard short-context price", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "42",
          provider: "openai",
          model: "gpt-5.4-mini",
          processing_tier: "standard",
          context_tier: "short",
          currency: "USD",
          input_per_million: "0.750000",
          cached_input_per_million: "0.075000",
          cache_write_per_million: null,
          output_per_million: "4.500000",
          source_url: "https://developers.openai.com/api/docs/pricing",
        },
      ],
    }));
    const svc = new LlmPricingService("postgres://db", logger(), () =>
      pool(query as ProcessLogPool["query"]),
    );

    const price = await svc.lookup({
      provider: "openai",
      model: "gpt-5.4-mini",
      at: new Date("2026-07-15T00:00:00Z"),
    });

    expect(price).toEqual(gpt54MiniStandard);
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0][0]).toContain("effective_from <= $5");
    expect(calls[0][1]).toEqual([
      "openai",
      "gpt-5.4-mini",
      "standard",
      "short",
      new Date("2026-07-15T00:00:00Z"),
    ]);
  });

  it("returns missing_price when no active row exists", async () => {
    const svc = new LlmPricingService("postgres://db", logger(), () =>
      pool(vi.fn(async () => ({ rows: [] })) as ProcessLogPool["query"]),
    );

    await expect(
      svc.estimateCost({
        provider: "openai",
        model: "unknown",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
    ).resolves.toEqual({ status: "missing_price" });
  });

  it("calculates gpt-5.4-mini standard cost with cached input tokens", () => {
    const cost = calculateLlmCost(
      {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 100,
        totalTokens: 1_100,
      },
      gpt54MiniStandard,
    );

    expect(cost).toMatchObject({
      estimated: 0.001065,
      currency: "USD",
      priceId: "42",
      processingTier: "standard",
      contextTier: "short",
    });
  });
});
