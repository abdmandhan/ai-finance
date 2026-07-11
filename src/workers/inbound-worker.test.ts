import type { Config } from "@/commons";
import { configUtils } from "@/commons";
import type { IKafkaService, IQueueService } from "@/services";
import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workerCtor = vi.fn();
vi.mock("groupmq", () => ({
  Worker: class {
    run = vi.fn();
    close = vi.fn(async () => undefined);
    constructor(opts: unknown) {
      workerCtor(opts);
    }
  },
}));

import { createInboundWorker } from "./inbound-worker";

const logger = pino({ level: "silent" });
const config: Config = configUtils.configSchema.parse({ kafka: {} });

function makeDeps() {
  const kafka = {
    publishInboundError: vi.fn(async () => undefined),
  } as unknown as IKafkaService & {
    publishInboundError: ReturnType<typeof vi.fn>;
  };
  const queueService = { inbound: () => ({}) } as unknown as IQueueService;
  const handle = vi.fn(async () => undefined);
  return { kafka, queueService, handle };
}

interface CapturedOpts {
  concurrency: number;
  maxAttempts: number;
  handler: (job: { data: unknown }) => Promise<void>;
  onError: (err: unknown, job?: { data?: unknown }) => Promise<void>;
}

describe("createInboundWorker", () => {
  beforeEach(() => workerCtor.mockClear());

  it("re-serializes the job payload into the MessageHandler contract", async () => {
    const { kafka, queueService, handle } = makeDeps();
    createInboundWorker({ queueService, kafka, logger, config, handle });

    const opts = workerCtor.mock.calls[0][0] as CapturedOpts;
    expect(opts.concurrency).toBe(config.worker.concurrency);
    expect(opts.maxAttempts).toBe(config.worker.max_attempts);

    const data = { requestId: "r-1", chatId: "c-1", createdBy: "u-1" };
    await opts.handler({ data });
    expect(handle).toHaveBeenCalledWith(JSON.stringify(data));
  });

  it("dead-letters exhausted jobs via publishInboundError", async () => {
    const { kafka, queueService, handle } = makeDeps();
    createInboundWorker({ queueService, kafka, logger, config, handle });

    const opts = workerCtor.mock.calls[0][0] as CapturedOpts;
    const err = new Error("job failed");
    const data = { requestId: "r-2", chatId: "c-2" };
    await opts.onError(err, { data });

    expect(kafka.publishInboundError).toHaveBeenCalledWith("c-2", {
      error: err,
      data,
    });
  });

  it("onError survives a failing publish and a missing job", async () => {
    const { kafka, queueService, handle } = makeDeps();
    kafka.publishInboundError.mockRejectedValue(new Error("kafka down"));
    createInboundWorker({ queueService, kafka, logger, config, handle });

    const opts = workerCtor.mock.calls[0][0] as CapturedOpts;
    await expect(opts.onError(new Error("x"))).resolves.toBeUndefined();
    expect(kafka.publishInboundError).toHaveBeenCalledWith("", {
      error: expect.any(Error),
      data: undefined,
    });
  });
});
