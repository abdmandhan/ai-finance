import type { RunnableConfig } from "@langchain/core/runnables";
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackCheckpointer } from "./fallback-checkpointer";

const logger = pino({ level: "silent" });

const threadConfig = (id: string): RunnableConfig => ({
  configurable: { thread_id: id },
});

function makeTuple(threadId: string): CheckpointTuple {
  return {
    config: threadConfig(threadId),
    checkpoint: {
      v: 1,
      id: "ckpt-1",
      ts: "2026-01-01T00:00:00.000Z",
      channel_values: {},
      channel_versions: { ch: 1 },
      versions_seen: {},
    },
    metadata: { source: "loop", step: 1, parents: {} },
    pendingWrites: [
      ["task-1", "chanA", "valueA"],
      ["task-1", "chanB", "valueB"],
      ["task-2", "chanA", "valueC"],
    ],
  } as CheckpointTuple;
}

interface SaverStub {
  getTuple: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  putWrites: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  deleteThread: ReturnType<typeof vi.fn>;
  setup?: ReturnType<typeof vi.fn>;
}

function makeSaver(): SaverStub {
  return {
    getTuple: vi.fn(async () => undefined),
    put: vi.fn(async (config: RunnableConfig) => config),
    putWrites: vi.fn(async () => undefined),
     
    list: vi.fn(async function* () {}),
    deleteThread: vi.fn(async () => undefined),
    setup: vi.fn(async () => undefined),
  };
}

describe("FallbackCheckpointer", () => {
  let redis: SaverStub;
  let postgres: SaverStub;
  let saver: FallbackCheckpointer;

  beforeEach(() => {
    redis = makeSaver();
    postgres = makeSaver();
    saver = new FallbackCheckpointer(
      redis as unknown as RedisSaver,
      postgres as unknown as PostgresSaver,
      logger,
    );
  });

  it("serves getTuple from Redis when available", async () => {
    const tuple = makeTuple("t-1");
    redis.getTuple.mockResolvedValue(tuple);

    await expect(saver.getTuple(threadConfig("t-1"))).resolves.toBe(tuple);
    expect(postgres.getTuple).not.toHaveBeenCalled();
  });

  it("falls back to Postgres on Redis failure and hydrates Redis", async () => {
    const tuple = makeTuple("t-2");
    redis.getTuple.mockRejectedValue(new Error("redis down"));
    postgres.getTuple.mockResolvedValue(tuple);

    await expect(saver.getTuple(threadConfig("t-2"))).resolves.toBe(tuple);

    // hydration is fire-and-forget — flush microtasks
    await new Promise((resolve) => setImmediate(resolve));
    expect(redis.put).toHaveBeenCalledWith(
      tuple.config,
      tuple.checkpoint,
      tuple.metadata,
      tuple.checkpoint.channel_versions,
    );
    // pendingWrites grouped by taskId → two putWrites calls
    expect(redis.putWrites).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when both tiers fail", async () => {
    redis.getTuple.mockRejectedValue(new Error("redis down"));
    postgres.getTuple.mockRejectedValue(new Error("pg down"));

    await expect(saver.getTuple(threadConfig("t-3"))).resolves.toBeUndefined();
  });

  it("put falls back to Postgres when Redis fails", async () => {
    redis.put.mockRejectedValue(new Error("redis down"));
    const tuple = makeTuple("t-4");

    await saver.put(threadConfig("t-4"), tuple.checkpoint, tuple.metadata!, {});
    expect(postgres.put).toHaveBeenCalledTimes(1);
  });

  it("flushToPostgres replays dirty threads with grouped writes and clears them", async () => {
    const tuple = makeTuple("t-5");
    redis.getTuple.mockResolvedValue(tuple);

    // dirty the thread via a put
    await saver.put(threadConfig("t-5"), tuple.checkpoint, tuple.metadata!, {});
    await saver.flushToPostgres();

    expect(postgres.put).toHaveBeenCalledWith(
      tuple.config,
      tuple.checkpoint,
      tuple.metadata,
      tuple.checkpoint.channel_versions,
    );
    expect(postgres.putWrites).toHaveBeenCalledTimes(2); // task-1, task-2

    // second flush: nothing dirty anymore
    postgres.put.mockClear();
    await saver.flushToPostgres();
    expect(postgres.put).not.toHaveBeenCalled();
  });

  it("deleteThread deletes from both tiers best-effort", async () => {
    redis.deleteThread.mockRejectedValue(new Error("redis down"));

    await saver.deleteThread("t-6");
    expect(redis.deleteThread).toHaveBeenCalledWith("t-6");
    expect(postgres.deleteThread).toHaveBeenCalledWith("t-6");
  });

  it("setup passes through to the Postgres tier", async () => {
    await saver.setup();
    expect(postgres.setup).toHaveBeenCalledTimes(1);
  });
});
