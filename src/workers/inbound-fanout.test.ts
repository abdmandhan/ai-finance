import type { Config } from "@/commons";
import { configUtils } from "@/commons";
import type { ICacheService, IQueueService } from "@/services";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createInboundFanout } from "./inbound-fanout";

const logger = pino({ level: "silent" });

function makeConfig(over: Partial<Config["worker"]> = {}): Config {
  const config = configUtils.configSchema.parse({ kafka: {} });
  return { ...config, worker: { ...config.worker, ...over } };
}

function makeCache(): ICacheService {
  const seen = new Set<string>();
  return {
    setIfNotExist: vi.fn(async (key: string) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  } as unknown as ICacheService;
}

function makeQueue(backlogs: number[] = []) {
  const add = vi.fn(async () => undefined);
  let call = 0;
  const queueService = {
    inbound: () => ({ add }),
    inboundBacklogCount: vi.fn(async () =>
      call < backlogs.length ? backlogs[call++] : 0,
    ),
  } as unknown as IQueueService;
  return { queueService, add };
}

const rawMsg = (requestId: string, chatId = "chat-1") =>
  JSON.stringify({ requestId, chatId, createdBy: "u-1" });

describe("createInboundFanout", () => {
  it("validates, dedups, and enqueues with groupId=chatId jobId=requestId", async () => {
    const { queueService, add } = makeQueue();
    const fanout = createInboundFanout({
      queueService,
      cache: makeCache(),
      logger,
      config: makeConfig(),
    });

    await fanout.handler(rawMsg("r-1", "chat-9"));

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestId: "r-1", chatId: "chat-9" }),
      groupId: "chat-9",
      jobId: "r-1",
    });
  });

  it("skips a duplicate requestId", async () => {
    const { queueService, add } = makeQueue();
    const fanout = createInboundFanout({
      queueService,
      cache: makeCache(),
      logger,
      config: makeConfig(),
    });

    await fanout.handler(rawMsg("r-dup"));
    await fanout.handler(rawMsg("r-dup"));

    expect(add).toHaveBeenCalledTimes(1);
  });

  it("throws on invalid payload so the wrapper can dead-letter it", async () => {
    const { queueService } = makeQueue();
    const fanout = createInboundFanout({
      queueService,
      cache: makeCache(),
      logger,
      config: makeConfig(),
    });

    await expect(fanout.handler("not-json")).rejects.toThrow();
    await expect(fanout.handler("{}")).rejects.toThrow(); // missing required fields
  });

  it("waits while the backlog is full and proceeds when it drains", async () => {
    vi.useFakeTimers();
    try {
      // max_backlog 2: first two polls report full, third reports drained.
      const { queueService, add } = makeQueue([2, 3, 0]);
      const fanout = createInboundFanout({
        queueService,
        cache: makeCache(),
        logger,
        config: makeConfig({ max_backlog: 2 }),
      });

      const pending = fanout.handler(rawMsg("r-bp"));
      await vi.advanceTimersByTimeAsync(1_000); // two 500ms sleeps
      await pending;

      expect(add).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() unblocks a pending backlog wait without enqueueing", async () => {
    vi.useFakeTimers();
    try {
      const { queueService, add } = makeQueue([5, 5, 5, 5, 5]);
      const fanout = createInboundFanout({
        queueService,
        cache: makeCache(),
        logger,
        config: makeConfig({ max_backlog: 2 }),
      });

      const pending = fanout.handler(rawMsg("r-stop"));
      await vi.advanceTimersByTimeAsync(500);
      fanout.stop();
      await vi.advanceTimersByTimeAsync(500);
      await pending;

      expect(add).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
