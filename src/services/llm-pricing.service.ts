import type { ILogger } from "@/commons";
import { Pool } from "pg";
import {
  setupLlmModelPricesDbWithPool,
  type ProcessLogPool,
  type ProcessLogPoolFactory,
} from "./process-log.service";

export interface LlmPriceLookup {
  provider: string;
  model: string;
  processingTier?: string;
  contextTier?: string;
  at?: Date;
}

export interface LlmUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmModelPrice {
  id: string;
  provider: string;
  model: string;
  processingTier: string;
  contextTier: string;
  currency: string;
  inputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
  outputPerMillion: number;
  sourceUrl?: string;
}

export interface LlmCostEstimate {
  estimated: number;
  currency: string;
  priceId: string;
  processingTier: string;
  contextTier: string;
  pricingSource?: string;
}

export interface ILlmPricingService {
  lookup(input: LlmPriceLookup): Promise<LlmModelPrice | null>;
  estimateCost(input: {
    provider: string;
    model: string;
    usage?: LlmUsage;
    processingTier?: string;
    contextTier?: string;
    at?: Date;
  }): Promise<LlmCostEstimate | { status: "missing_price" } | undefined>;
  close(): Promise<void>;
}

interface LlmModelPriceRow {
  id: string;
  provider: string;
  model: string;
  processing_tier: string;
  context_tier: string;
  currency: string;
  input_per_million: string;
  cached_input_per_million: string | null;
  cache_write_per_million: string | null;
  output_per_million: string;
  source_url: string | null;
}

const DEFAULT_PROCESSING_TIER = "standard";
const DEFAULT_CONTEXT_TIER = "short";
const CACHE_TTL_MS = 5 * 60 * 1000;

function defaultPoolFactory(databaseUrl: string): ProcessLogPool {
  return new Pool({ connectionString: databaseUrl });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingRelationError(err: unknown): boolean {
  return isRecord(err) && err.code === "42P01";
}

function toPrice(row: LlmModelPriceRow): LlmModelPrice {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    processingTier: row.processing_tier,
    contextTier: row.context_tier,
    currency: row.currency,
    inputPerMillion: Number(row.input_per_million),
    cachedInputPerMillion:
      row.cached_input_per_million === null
        ? undefined
        : Number(row.cached_input_per_million),
    cacheWritePerMillion:
      row.cache_write_per_million === null
        ? undefined
        : Number(row.cache_write_per_million),
    outputPerMillion: Number(row.output_per_million),
    sourceUrl: row.source_url ?? undefined,
  };
}

function cacheKey(input: Required<Pick<LlmPriceLookup, "provider" | "model">> & {
  processingTier: string;
  contextTier: string;
}): string {
  return [
    input.provider,
    input.model,
    input.processingTier,
    input.contextTier,
  ].join(":");
}

export function calculateLlmCost(
  usage: LlmUsage | undefined,
  price: LlmModelPrice,
): LlmCostEstimate | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (
    inputTokens === 0 &&
    cachedInputTokens === 0 &&
    cacheWriteTokens === 0 &&
    outputTokens === 0
  ) {
    return undefined;
  }

  const uncachedInputTokens = Math.max(
    0,
    inputTokens - cachedInputTokens - cacheWriteTokens,
  );
  const cachedRate =
    price.cachedInputPerMillion === undefined
      ? price.inputPerMillion
      : price.cachedInputPerMillion;
  const cacheWriteRate =
    price.cacheWritePerMillion === undefined
      ? price.inputPerMillion
      : price.cacheWritePerMillion;
  const estimated =
    (uncachedInputTokens * price.inputPerMillion +
      cachedInputTokens * cachedRate +
      cacheWriteTokens * cacheWriteRate +
      outputTokens * price.outputPerMillion) /
    1_000_000;

  return {
    estimated: Number(estimated.toFixed(12)),
    currency: price.currency,
    priceId: price.id,
    processingTier: price.processingTier,
    contextTier: price.contextTier,
    pricingSource: price.sourceUrl,
  };
}

export class LlmPricingService implements ILlmPricingService {
  private readonly pool?: ProcessLogPool;
  private readonly cache = new Map<
    string,
    { expiresAt: number; price: LlmModelPrice | null }
  >();
  private setupPromise: Promise<void> | null = null;

  constructor(
    databaseUrl: string,
    private readonly logger: ILogger,
    poolFactory: ProcessLogPoolFactory = defaultPoolFactory,
  ) {
    this.logger = logger.child({ service: "LlmPricingService" });
    if (databaseUrl) {
      this.pool = poolFactory(databaseUrl);
    } else {
      this.logger.warn(
        "No database.url configured — LLM cost estimates will be unavailable",
      );
    }
  }

  async lookup(input: LlmPriceLookup): Promise<LlmModelPrice | null> {
    if (!this.pool) return null;
    const normalized = {
      provider: input.provider,
      model: input.model,
      processingTier: input.processingTier ?? DEFAULT_PROCESSING_TIER,
      contextTier: input.contextTier ?? DEFAULT_CONTEXT_TIER,
    };
    const key = cacheKey(normalized);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.price;

    try {
      const price = await this.queryPrice(normalized, input.at ?? new Date());
      this.cache.set(key, { price, expiresAt: Date.now() + CACHE_TTL_MS });
      return price;
    } catch (err) {
      if (!isMissingRelationError(err)) {
        this.logger.error({ err, ...normalized }, "LLM price lookup failed");
        return null;
      }
      await this.ensureStorage();
      const price = await this.queryPrice(normalized, input.at ?? new Date());
      this.cache.set(key, { price, expiresAt: Date.now() + CACHE_TTL_MS });
      return price;
    }
  }

  async estimateCost(input: {
    provider: string;
    model: string;
    usage?: LlmUsage;
    processingTier?: string;
    contextTier?: string;
    at?: Date;
  }): Promise<LlmCostEstimate | { status: "missing_price" } | undefined> {
    if (!input.usage) return undefined;
    const price = await this.lookup(input);
    if (!price) return { status: "missing_price" };
    return calculateLlmCost(input.usage, price);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private async queryPrice(
    input: {
      provider: string;
      model: string;
      processingTier: string;
      contextTier: string;
    },
    at: Date,
  ): Promise<LlmModelPrice | null> {
    const result = await this.pool!.query<LlmModelPriceRow>(
      `SELECT
         id::text, provider, model, processing_tier, context_tier, currency,
         input_per_million::text, cached_input_per_million::text,
         cache_write_per_million::text, output_per_million::text, source_url
       FROM llm_model_prices
       WHERE provider = $1
         AND model = $2
         AND processing_tier = $3
         AND context_tier = $4
         AND effective_from <= $5
         AND (effective_to IS NULL OR effective_to > $5)
       ORDER BY effective_from DESC, id DESC
       LIMIT 1`,
      [
        input.provider,
        input.model,
        input.processingTier,
        input.contextTier,
        at,
      ],
    );
    return result.rows?.[0] ? toPrice(result.rows[0]) : null;
  }

  private async ensureStorage(): Promise<void> {
    if (!this.pool) return;
    if (!this.setupPromise) {
      this.setupPromise = setupLlmModelPricesDbWithPool(this.pool).catch(
        (err) => {
          this.setupPromise = null;
          throw err;
        },
      );
    }
    await this.setupPromise;
  }
}

export function createLlmPricingService(
  databaseUrl: string,
  logger: ILogger,
  poolFactory: ProcessLogPoolFactory = defaultPoolFactory,
): ILlmPricingService {
  return new LlmPricingService(databaseUrl, logger, poolFactory);
}
