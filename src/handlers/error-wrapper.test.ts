import type { IKafkaService } from "@/services";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createErrorPublishingHandler } from "./error-wrapper";

const logger = pino({ level: "silent" });

function makeKafka() {
  return {
    publishInboundError: vi.fn(async () => undefined),
  } as unknown as IKafkaService & {
    publishInboundError: ReturnType<typeof vi.fn>;
  };
}

describe("createErrorPublishingHandler", () => {
  it("does not publish when the inner handler succeeds", async () => {
    const kafka = makeKafka();
    const inner = vi.fn(async () => undefined);
    const handler = createErrorPublishingHandler({ inner, kafka, logger });

    await handler('{"chatId":"c-1"}');

    expect(inner).toHaveBeenCalledTimes(1);
    expect(kafka.publishInboundError).not.toHaveBeenCalled();
  });

  it("retries then dead-letters with parsed data and never throws", async () => {
    const kafka = makeKafka();
    const error = new Error("handler boom");
    const inner = vi.fn(async () => {
      throw error;
    });
    const handler = createErrorPublishingHandler({
      inner,
      kafka,
      logger,
      attempts: 2,
    });

    await expect(
      handler('{"chatId":"c-2","requestId":"r-1"}'),
    ).resolves.toBeUndefined();

    expect(inner).toHaveBeenCalledTimes(2);
    expect(kafka.publishInboundError).toHaveBeenCalledWith("c-2", {
      error,
      data: { chatId: "c-2", requestId: "r-1" },
    });
  });

  it("dead-letters unparseable raw as the raw string", async () => {
    const kafka = makeKafka();
    const inner = vi.fn(async () => {
      throw new Error("bad");
    });
    const handler = createErrorPublishingHandler({
      inner,
      kafka,
      logger,
      attempts: 1,
    });

    await handler("not-json");

    expect(kafka.publishInboundError).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ data: "not-json" }),
    );
  });

  it("survives a failing publishInboundError", async () => {
    const kafka = makeKafka();
    kafka.publishInboundError.mockRejectedValue(new Error("kafka down"));
    const inner = vi.fn(async () => {
      throw new Error("bad");
    });
    const handler = createErrorPublishingHandler({
      inner,
      kafka,
      logger,
      attempts: 1,
    });

    await expect(handler('{"chatId":"c-3"}')).resolves.toBeUndefined();
  });
});
