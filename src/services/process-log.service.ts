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
}

export interface ProcessLogPool {
  query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }>;
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
];

function defaultPoolFactory(databaseUrl: string): ProcessLogPool {
  return new Pool({ connectionString: databaseUrl });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingRelationError(err: unknown): boolean {
  return isRecord(err) && err.code === "42P01";
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
  for (const sql of PROCESS_LOG_INDEX_DDL) await pool.query(sql);
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
      if (!isMissingRelationError(err)) throw err;
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
         duration_ms, payload, error
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17::jsonb, $18::jsonb
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
