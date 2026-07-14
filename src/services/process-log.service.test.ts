import type { ILogger } from "@/commons";
import { describe, expect, it, vi } from "vitest";
import {
  LLM_MODEL_PRICES_INDEX_DDL,
  LLM_MODEL_PRICES_SEED_DML,
  LLM_MODEL_PRICES_TABLE_DDL,
  PROCESS_LOG_INDEX_DDL,
  PROCESS_LOG_LLM_COLUMNS_DDL,
  PROCESS_LOG_TABLE_DDL,
  ProcessLogService,
  sanitizeForProcessLog,
  setupProcessLogDb,
  type ProcessLogPool,
} from "./process-log.service";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as ILogger & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function pool(
  query: ProcessLogPool["query"] = vi.fn(async () => ({ rowCount: 0 })),
) {
  return {
    query,
    end: vi.fn(async () => {}),
  } satisfies ProcessLogPool;
}

const enabledConfig = {
  enabled: true,
  store_db: true,
  include_payloads: true,
  retention_days: 14,
  max_payload_chars: 4000,
};

describe("ProcessLogService", () => {
  it("is a no-op when disabled", async () => {
    const log = logger();
    const svc = new ProcessLogService(
      { ...enabledConfig, enabled: false },
      log,
      "",
    );

    await svc.runWithContext({ chatId: "chat-1" }, async () => {
      svc.log({ event: "prompt.received" });
    });

    expect(log.info).not.toHaveBeenCalled();
  });

  it("emits trace context with increasing sequence numbers", async () => {
    const log = logger();
    const svc = new ProcessLogService(
      { ...enabledConfig, store_db: false },
      log,
      "",
    );

    await svc.runWithContext(
      { chatId: "chat-1", requestId: "req-1", tenantId: "tenant-1" },
      async () => {
        svc.log({ event: "prompt.received" });
        svc.log({ event: "assistant.invoke" });
      },
    );

    expect(log.info.mock.calls[0][0]).toMatchObject({
      processLog: true,
      traceId: "req-1",
      chatId: "chat-1",
      tenantId: "tenant-1",
      seq: 1,
      event: "prompt.received",
    });
    expect(log.info.mock.calls[1][0]).toMatchObject({
      seq: 2,
      event: "assistant.invoke",
    });
  });

  it("stores rows by chat_id without blocking callers", async () => {
    const log = logger();
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const svc = new ProcessLogService(enabledConfig, log, "postgres://db", () =>
      pool(query),
    );

    await svc.runWithContext(
      { chatId: "chat-2", requestId: "req-2" },
      async () => {
        svc.log({ event: "tool.call", payload: { ok: true } });
      },
    );
    await svc.flush();

    expect(query).toHaveBeenCalledOnce();
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0][0]).toContain("INSERT INTO graph_process_logs");
    expect(calls[0][1]).toContain("chat-2");
  });

  it("stores LLM usage and cost in typed columns", async () => {
    const log = logger();
    const query = vi.fn(async () => ({ rowCount: 1 }));
    const svc = new ProcessLogService(enabledConfig, log, "postgres://db", () =>
      pool(query),
    );

    await svc.runWithContext({ chatId: "chat-llm" }, async () => {
      svc.log({
        event: "assistant.model_call",
        stage: "llm.chat.end",
        payload: { ok: true },
        llm: {
          provider: "openai",
          model: "gpt-5.4-mini",
          modelKey: "openai:gpt-5.4-mini",
          modelSize: "large",
          inputTokens: 1_000,
          cachedInputTokens: 200,
          outputTokens: 100,
          totalTokens: 1_100,
          costEstimated: 0.001065,
          costCurrency: "USD",
          costStatus: "estimated",
          priceId: "42",
          processingTier: "standard",
          contextTier: "short",
        },
      });
    });
    await svc.flush();

    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0][0]).toContain("llm_provider");
    expect(calls[0][0]).toContain("llm_cost_estimated");
    expect(calls[0][1].slice(18)).toEqual([
      "openai",
      "gpt-5.4-mini",
      "openai:gpt-5.4-mini",
      "large",
      1_000,
      200,
      null,
      100,
      1_100,
      0.001065,
      "USD",
      "estimated",
      "42",
      "standard",
      "short",
    ]);
  });

  it("creates storage and retries once when the process log table is missing", async () => {
    const log = logger();
    let insertAttempts = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO graph_process_logs")) {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          throw Object.assign(
            new Error('relation "graph_process_logs" does not exist'),
            { code: "42P01" },
          );
        }
      }
      return { rowCount: 1 };
    });
    const svc = new ProcessLogService(enabledConfig, log, "postgres://db", () =>
      pool(query),
    );

    await svc.runWithContext({ chatId: "chat-missing-table" }, async () => {
      svc.log({ event: "prompt.received" });
    });
    await svc.flush();

    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(insertAttempts).toBe(2);
    expect(sqlCalls).toContain(PROCESS_LOG_TABLE_DDL);
    for (const sql of PROCESS_LOG_LLM_COLUMNS_DDL) {
      expect(sqlCalls).toContain(sql);
    }
    for (const sql of PROCESS_LOG_INDEX_DDL) {
      expect(sqlCalls).toContain(sql);
    }
    expect(sqlCalls).toContain(LLM_MODEL_PRICES_TABLE_DDL);
    for (const sql of LLM_MODEL_PRICES_INDEX_DDL) {
      expect(sqlCalls).toContain(sql);
    }
    for (const sql of LLM_MODEL_PRICES_SEED_DML) {
      expect(sqlCalls).toContain(sql);
    }
    expect(log.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "graph process log insert failed",
    );
  });

  it("redacts secrets and truncates large payloads", () => {
    const out = sanitizeForProcessLog(
      {
        authorization: "Bearer token",
        nested: { accessToken: "secret-token", value: "ok" },
        bytes: new Uint8Array([1, 2, 3]),
        long: "x".repeat(100),
      },
      80,
    ) as { truncated: boolean; preview: string };

    expect(out.truncated).toBe(true);
    expect(out.preview).toContain("[redacted]");
    expect(out.preview).not.toContain("secret-token");
  });

  it("logs DB insert failures without throwing", async () => {
    const log = logger();
    const query = vi.fn(async () => {
      throw new Error("db down");
    });
    const svc = new ProcessLogService(enabledConfig, log, "postgres://db", () =>
      pool(query),
    );

    await svc.runWithContext({ chatId: "chat-3" }, async () => {
      expect(() => svc.log({ event: "prompt.received" })).not.toThrow();
    });
    await svc.flush();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "graph process log insert failed",
    );
  });

  it("cleans up expired rows using configured retention days", async () => {
    const log = logger();
    const query = vi.fn(async () => ({ rowCount: 2 }));
    const svc = new ProcessLogService(
      { ...enabledConfig, retention_days: 30 },
      log,
      "postgres://db",
      () => pool(query),
    );

    await svc.cleanupExpired();

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM graph_process_logs"),
      [30],
    );
    expect(log.info).toHaveBeenCalledWith(
      { deleted: 2 },
      "graph process log retention cleanup complete",
    );
  });

  it("sets up the process log table and indexes idempotently", async () => {
    const log = logger();
    const p = pool();

    await setupProcessLogDb("postgres://db", log, () => p);

    expect(p.query).toHaveBeenCalledTimes(
      1 +
        PROCESS_LOG_LLM_COLUMNS_DDL.length +
        PROCESS_LOG_INDEX_DDL.length +
        1 +
        LLM_MODEL_PRICES_INDEX_DDL.length +
        LLM_MODEL_PRICES_SEED_DML.length,
    );
    expect(p.query).toHaveBeenCalledWith(PROCESS_LOG_TABLE_DDL);
    for (const sql of PROCESS_LOG_LLM_COLUMNS_DDL) {
      expect(p.query).toHaveBeenCalledWith(sql);
      expect(sql).toContain("ADD COLUMN IF NOT EXISTS");
    }
    for (const sql of PROCESS_LOG_INDEX_DDL) {
      expect(p.query).toHaveBeenCalledWith(sql);
      expect(sql).toContain("IF NOT EXISTS");
    }
    expect(p.query).toHaveBeenCalledWith(LLM_MODEL_PRICES_TABLE_DDL);
    for (const sql of LLM_MODEL_PRICES_INDEX_DDL) {
      expect(p.query).toHaveBeenCalledWith(sql);
      expect(sql).toContain("IF NOT EXISTS");
    }
    for (const sql of LLM_MODEL_PRICES_SEED_DML) {
      expect(p.query).toHaveBeenCalledWith(sql);
      expect(sql).toContain("ON CONFLICT");
    }
    expect(p.end).toHaveBeenCalledOnce();
  });
});
