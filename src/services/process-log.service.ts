import type { Config, ILogger } from "@/commons";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface ProcessLogContext {
  traceId?: string;
  chatId: string;
  requestId?: string;
  tenantId?: string;
  messageId?: string;
  userId?: string;
  provider?: string;
}

export interface ProcessLogEntry {
  event: string;
  stage?: string;
  workflow?: string;
  node?: string;
  tool?: string;
  status?: string;
  durationMs?: number;
  payload?: unknown;
  error?: unknown;
  llm?: ProcessLogLlmMetrics;
}

export interface ProcessLogLlmMetrics {
  provider?: string;
  model?: string;
  modelKey?: string;
  modelSize?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costEstimated?: number;
  costCurrency?: string;
  costStatus?: string;
  priceId?: string | number;
  processingTier?: string;
  contextTier?: string;
}

export interface IProcessLogService {
  runWithContext<T>(
    context: ProcessLogContext,
    fn: () => Promise<T>,
  ): Promise<T>;
  log(entry: ProcessLogEntry): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  cleanupExpired(): Promise<void>;
  startRetention(): () => void;
}

interface StoredProcessLogContext extends ProcessLogContext {
  traceId: string;
  seq: number;
}

interface ProcessLogRow extends StoredProcessLogContext {
  seq: number;
  createdAt: Date;
  event: string;
  stage?: string;
  workflow?: string;
  node?: string;
  tool?: string;
  status?: string;
  durationMs?: number;
  payload?: unknown;
  error?: unknown;
  llm?: ProcessLogLlmMetrics;
}

export interface ProcessLogPool {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount?: number | null; rows?: T[] }>;
  end(): Promise<void>;
}

export type ProcessLogPoolFactory = (databaseUrl: string) => ProcessLogPool;

const REDACTED = "[redacted]";
const BINARY_REDACTED = "[binary redacted]";
const MAX_ARRAY_ITEMS = 100;

const SECRET_KEY_PATTERN =
  /(authorization|cookie|password|passwd|secret|token|access.?token|refresh.?token|api.?key|apikey|client.?secret|private.?key|session)/i;

export const PROCESS_LOG_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS graph_process_logs (
  id          bigserial PRIMARY KEY,
  trace_id    text NOT NULL,
  seq         integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  chat_id     text,
  request_id  text,
  tenant_id   text,
  message_id  text,
  user_id     text,
  provider    text,
  event       text NOT NULL,
  stage       text,
  workflow    text,
  node        text,
  tool        text,
  status      text,
  duration_ms integer,
  payload     jsonb,
  error       jsonb
)`;

export const PROCESS_LOG_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS graph_process_logs_chat_created_idx
     ON graph_process_logs (chat_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS graph_process_logs_trace_seq_idx
     ON graph_process_logs (trace_id, seq)`,
  `CREATE INDEX IF NOT EXISTS graph_process_logs_created_idx
     ON graph_process_logs (created_at)`,
  `CREATE INDEX IF NOT EXISTS graph_process_logs_llm_tenant_created_idx
     ON graph_process_logs (tenant_id, created_at)
     WHERE llm_provider IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS graph_process_logs_llm_model_created_idx
     ON graph_process_logs (llm_provider, llm_model, created_at)
     WHERE llm_provider IS NOT NULL`,
];

export const PROCESS_LOG_LLM_COLUMNS_DDL = [
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_provider text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_model text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_model_key text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_model_size text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_input_tokens integer`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_cached_input_tokens integer`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_cache_write_tokens integer`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_output_tokens integer`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_total_tokens integer`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_cost_estimated numeric(18, 12)`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_cost_currency text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_cost_status text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_price_id bigint`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_processing_tier text`,
  `ALTER TABLE graph_process_logs
     ADD COLUMN IF NOT EXISTS llm_context_tier text`,
];

export const LLM_MODEL_PRICES_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS llm_model_prices (
  id                         bigserial PRIMARY KEY,
  provider                   text NOT NULL,
  model                      text NOT NULL,
  processing_tier            text NOT NULL,
  context_tier               text NOT NULL,
  currency                   text NOT NULL DEFAULT 'USD',
  input_per_million          numeric(12, 6) NOT NULL,
  cached_input_per_million   numeric(12, 6),
  cache_write_per_million    numeric(12, 6),
  output_per_million         numeric(12, 6) NOT NULL,
  effective_from             timestamptz NOT NULL DEFAULT now(),
  effective_to               timestamptz,
  source_url                 text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_model_prices_effective_range
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT llm_model_prices_unique_effective
    UNIQUE (provider, model, processing_tier, context_tier, effective_from)
)`;

export const LLM_MODEL_PRICES_INDEX_DDL = [
  `CREATE INDEX IF NOT EXISTS llm_model_prices_lookup_idx
     ON llm_model_prices (
       provider, model, processing_tier, context_tier, effective_from DESC
     )`,
];

const OPENAI_PRICING_SOURCE_URL = "https://developers.openai.com/api/docs/pricing";

export const LLM_MODEL_PRICES_SEED_DML = [
  seedLlmModelPriceSql({
    provider: "openai",
    model: "gpt-5.4-mini",
    processingTier: "standard",
    contextTier: "short",
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
  }),
  seedLlmModelPriceSql({
    provider: "openai",
    model: "gpt-5.4-mini",
    processingTier: "batch",
    contextTier: "short",
    inputPerMillion: 0.375,
    cachedInputPerMillion: 0.0375,
    outputPerMillion: 2.25,
  }),
  seedLlmModelPriceSql({
    provider: "openai",
    model: "gpt-5.4-mini",
    processingTier: "flex",
    contextTier: "short",
    inputPerMillion: 0.375,
    cachedInputPerMillion: 0.0375,
    outputPerMillion: 2.25,
  }),
  seedLlmModelPriceSql({
    provider: "openai",
    model: "gpt-5.4-mini",
    processingTier: "priority",
    contextTier: "short",
    inputPerMillion: 1.5,
    cachedInputPerMillion: 0.15,
    outputPerMillion: 9,
  }),
];

function seedLlmModelPriceSql(input: {
  provider: string;
  model: string;
  processingTier: string;
  contextTier: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}): string {
  return `
INSERT INTO llm_model_prices (
  provider, model, processing_tier, context_tier, currency,
  input_per_million, cached_input_per_million, cache_write_per_million,
  output_per_million, effective_from, source_url
)
VALUES (
  '${input.provider}', '${input.model}', '${input.processingTier}',
  '${input.contextTier}', 'USD', ${input.inputPerMillion},
  ${input.cachedInputPerMillion}, NULL, ${input.outputPerMillion},
  '2026-07-14T00:00:00Z', '${OPENAI_PRICING_SOURCE_URL}'
)
ON CONFLICT (provider, model, processing_tier, context_tier, effective_from)
DO UPDATE SET
  currency = EXCLUDED.currency,
  input_per_million = EXCLUDED.input_per_million,
  cached_input_per_million = EXCLUDED.cached_input_per_million,
  cache_write_per_million = EXCLUDED.cache_write_per_million,
  output_per_million = EXCLUDED.output_per_million,
  source_url = EXCLUDED.source_url,
  updated_at = now()`;
}

function defaultPoolFactory(databaseUrl: string): ProcessLogPool {
  return new Pool({ connectionString: databaseUrl });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingStorageError(err: unknown): boolean {
  return isRecord(err) && (err.code === "42P01" || err.code === "42703");
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return BINARY_REDACTED;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return BINARY_REDACTED;
  }
  if (!isRecord(value)) return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, seen));
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeValue(child, seen);
  }
  return out;
}

export function sanitizeForProcessLog(
  value: unknown,
  maxPayloadChars: number,
): unknown {
  if (value === undefined) return undefined;
  const sanitized = sanitizeValue(value);
  const json = JSON.stringify(sanitized);
  if (json.length <= maxPayloadChars) return sanitized;
  return {
    truncated: true,
    originalChars: json.length,
    preview: json.slice(0, maxPayloadChars),
  };
}

async function setupProcessLogDbWithPool(pool: ProcessLogPool): Promise<void> {
  await pool.query(PROCESS_LOG_TABLE_DDL);
  for (const sql of PROCESS_LOG_LLM_COLUMNS_DDL) await pool.query(sql);
  for (const sql of PROCESS_LOG_INDEX_DDL) await pool.query(sql);
  await setupLlmModelPricesDbWithPool(pool);
}

export async function setupLlmModelPricesDbWithPool(
  pool: ProcessLogPool,
): Promise<void> {
  await pool.query(LLM_MODEL_PRICES_TABLE_DDL);
  for (const sql of LLM_MODEL_PRICES_INDEX_DDL) await pool.query(sql);
  for (const sql of LLM_MODEL_PRICES_SEED_DML) await pool.query(sql);
}

export async function setupProcessLogDb(
  databaseUrl: string,
  logger: ILogger,
  poolFactory: ProcessLogPoolFactory = defaultPoolFactory,
): Promise<void> {
  if (!databaseUrl) {
    logger.warn(
      "No database.url configured — skipping graph_process_logs setup",
    );
    return;
  }
  const pool = poolFactory(databaseUrl);
  try {
    await setupProcessLogDbWithPool(pool);
  } finally {
    await pool.end();
  }
}

export class ProcessLogService implements IProcessLogService {
  private readonly storage = new AsyncLocalStorage<StoredProcessLogContext>();
  private readonly pending = new Set<Promise<void>>();
  private readonly pool?: ProcessLogPool;
  private setupPromise: Promise<void> | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config["process_log"],
    private readonly logger: ILogger,
    databaseUrl: string,
    poolFactory: ProcessLogPoolFactory = defaultPoolFactory,
  ) {
    if (config.enabled && config.store_db && databaseUrl) {
      this.pool = poolFactory(databaseUrl);
    } else if (config.enabled && config.store_db && !databaseUrl) {
      this.logger.warn(
        "No database.url configured — process logs will only be written to server logs",
      );
    }
  }

  async runWithContext<T>(
    context: ProcessLogContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.config.enabled) return fn();
    return this.storage.run(
      {
        ...context,
        traceId: context.traceId ?? context.requestId ?? randomUUID(),
        seq: 0,
      },
      fn,
    );
  }

  log(entry: ProcessLogEntry): void {
    if (!this.config.enabled) return;
    const context = this.storage.getStore();
    if (!context) return;

    context.seq += 1;
    const row: ProcessLogRow = {
      ...context,
      seq: context.seq,
      createdAt: new Date(),
      event: entry.event,
      stage: entry.stage,
      workflow: entry.workflow,
      node: entry.node,
      tool: entry.tool,
      status: entry.status,
      durationMs:
        entry.durationMs === undefined ? undefined : Math.round(entry.durationMs),
      payload: this.config.include_payloads
        ? sanitizeForProcessLog(entry.payload, this.config.max_payload_chars)
        : undefined,
      error:
        entry.error === undefined
          ? undefined
          : sanitizeForProcessLog(entry.error, this.config.max_payload_chars),
      llm: entry.llm,
    };

    this.logger.info(
      {
        processLog: true,
        traceId: row.traceId,
        seq: row.seq,
        chatId: row.chatId,
        requestId: row.requestId,
        tenantId: row.tenantId,
        messageId: row.messageId,
        userId: row.userId,
        provider: row.provider,
        event: row.event,
        stage: row.stage,
        workflow: row.workflow,
        node: row.node,
        tool: row.tool,
        status: row.status,
        durationMs: row.durationMs,
        payload: row.payload,
        error: row.error,
        llm: row.llm,
      },
      "graph process log",
    );

    if (this.pool) this.enqueueInsert(row);
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.flush();
    await this.pool?.end();
  }

  async cleanupExpired(): Promise<void> {
    if (!this.pool) return;
    try {
      const result = await this.pool.query(
        `DELETE FROM graph_process_logs
         WHERE created_at < now() - make_interval(days => $1::int)`,
        [this.config.retention_days],
      );
      this.logger.info(
        { deleted: result.rowCount ?? 0 },
        "graph process log retention cleanup complete",
      );
    } catch (err) {
      this.logger.error({ err }, "graph process log retention cleanup failed");
    }
  }

  startRetention(): () => void {
    if (!this.pool || this.cleanupTimer) return () => {};
    void this.cleanupExpired();
    this.cleanupTimer = setInterval(
      () => void this.cleanupExpired(),
      60 * 60 * 1000,
    );
    this.cleanupTimer.unref?.();
    return () => {
      if (!this.cleanupTimer) return;
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    };
  }

  private enqueueInsert(row: ProcessLogRow): void {
    const insert = this.insert(row)
      .catch((err) => {
        this.logger.error({ err }, "graph process log insert failed");
      })
      .finally(() => {
        this.pending.delete(insert);
      });
    this.pending.add(insert);
  }

  private async insert(row: ProcessLogRow): Promise<void> {
    try {
      await this.insertRow(row);
    } catch (err) {
      if (!isMissingStorageError(err)) throw err;
      await this.ensureStorage();
      await this.insertRow(row);
    }
  }

  private async ensureStorage(): Promise<void> {
    if (!this.pool) return;
    if (!this.setupPromise) {
      this.setupPromise = setupProcessLogDbWithPool(this.pool).catch((err) => {
        this.setupPromise = null;
        throw err;
      });
    }
    await this.setupPromise;
  }

  private async insertRow(row: ProcessLogRow): Promise<void> {
    await this.pool!.query(
      `INSERT INTO graph_process_logs (
         trace_id, seq, created_at, chat_id, request_id, tenant_id, message_id,
         user_id, provider, event, stage, workflow, node, tool, status,
         duration_ms, payload, error,
         llm_provider, llm_model, llm_model_key, llm_model_size,
         llm_input_tokens, llm_cached_input_tokens, llm_cache_write_tokens,
         llm_output_tokens, llm_total_tokens, llm_cost_estimated,
         llm_cost_currency, llm_cost_status, llm_price_id,
         llm_processing_tier, llm_context_tier
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17::jsonb, $18::jsonb,
         $19, $20, $21, $22,
         $23, $24, $25,
         $26, $27, $28,
         $29, $30, $31,
         $32, $33
       )`,
      [
        row.traceId,
        row.seq,
        row.createdAt,
        row.chatId,
        row.requestId,
        row.tenantId,
        row.messageId,
        row.userId,
        row.provider,
        row.event,
        row.stage,
        row.workflow,
        row.node,
        row.tool,
        row.status,
        row.durationMs,
        row.payload === undefined ? null : JSON.stringify(row.payload),
        row.error === undefined ? null : JSON.stringify(row.error),
        row.llm?.provider ?? null,
        row.llm?.model ?? null,
        row.llm?.modelKey ?? null,
        row.llm?.modelSize ?? null,
        row.llm?.inputTokens ?? null,
        row.llm?.cachedInputTokens ?? null,
        row.llm?.cacheWriteTokens ?? null,
        row.llm?.outputTokens ?? null,
        row.llm?.totalTokens ?? null,
        row.llm?.costEstimated ?? null,
        row.llm?.costCurrency ?? null,
        row.llm?.costStatus ?? null,
        row.llm?.priceId ?? null,
        row.llm?.processingTier ?? null,
        row.llm?.contextTier ?? null,
      ],
    );
  }
}

export function createProcessLogService(
  config: Pick<Config, "process_log" | "database">,
  logger: ILogger,
  poolFactory: ProcessLogPoolFactory = defaultPoolFactory,
): IProcessLogService {
  return new ProcessLogService(
    config.process_log,
    logger,
    config.database.url,
    poolFactory,
  );
}
