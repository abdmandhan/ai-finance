import type { Config, ILogger } from "@/commons";
import { cacheKeys, cacheTtl } from "@/commons";
import { inboundMessageSchema } from "@/schemas";
import type { ICacheService, IQueueService, MessageHandler } from "@/services";

export interface InboundFanout {
  /** Kafka MessageHandler: validate → dedup → backpressure → enqueue. */
  handler: MessageHandler;
  /** Unblocks a pending backpressure wait so shutdown can proceed. */
  stop(): void;
}

export interface InboundFanoutDeps {
  queueService: IQueueService;
  cache: ICacheService;
  logger: ILogger;
  config: Config;
}

/**
 * The Kafka→queue seam. Per-partition ordering is preserved because the
 * awaited handler is called per message; per-chat ordering downstream comes
 * from groupmq's groupId (= chatId) FIFO grouping. Validation errors throw so
 * the error-publishing wrapper dead-letters them.
 *
 * Note: the dedup key is written before enqueue, so a crash between the two
 * drops the message (at-most-once). Parity with the old workers app.
 */
export function createInboundFanout(deps: InboundFanoutDeps): InboundFanout {
  const { queueService, cache, config } = deps;
  const logger = deps.logger.child({ name: "InboundFanout" });
  let shuttingDown = false;

  async function waitForBacklog(): Promise<void> {
    while (!shuttingDown) {
      const backlog = await queueService.inboundBacklogCount();
      if (backlog < config.worker.max_backlog) return;
      logger.warn({ backlog }, "queue backlog full — pausing Kafka intake");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return {
    async handler(raw: string): Promise<void> {
      if (shuttingDown) return;

      const msg = inboundMessageSchema.parse(JSON.parse(raw));

      const isFirst = await cache.setIfNotExist(
        cacheKeys.inboundDedupKey(msg.requestId),
        msg.requestId,
        cacheTtl.fanoutDedup,
      );
      if (!isFirst) {
        logger.info(
          { requestId: msg.requestId, chatId: msg.chatId },
          "Ignore duplicate message",
        );
        return;
      }

      await waitForBacklog();
      if (shuttingDown) return;

      logger.info(
        { chatId: msg.chatId, requestId: msg.requestId },
        "Push to queue",
      );
      await queueService.inbound().add({
        data: msg,
        groupId: msg.chatId,
        jobId: msg.requestId,
      });
    },

    stop(): void {
      shuttingDown = true;
    },
  };
}
