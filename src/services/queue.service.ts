import type { Config, ILogger } from "@/commons";
import type { InboundMessage } from "@/schemas";
import { Queue } from "groupmq";
import type { ICacheService } from "./cache.service";

export interface IQueueService {
  inbound(): Queue<InboundMessage>;
  /** Jobs not yet finished: active + waiting + delayed. */
  inboundBacklogCount(): Promise<number>;
}

export class QueueService implements IQueueService {
  private readonly inboundQueue: Queue<InboundMessage>;

  constructor(config: Config, cache: ICacheService, logger: ILogger) {
    this.inboundQueue = new Queue<InboundMessage>({
      redis: cache.client(),
      namespace: "graph-inbound",
      keepCompleted: config.worker.keep_completed,
      keepFailed: config.worker.keep_failed,
      jobTimeoutMs: config.worker.job_timeout_ms,
      logger,
    });
  }

  inbound(): Queue<InboundMessage> {
    return this.inboundQueue;
  }

  async inboundBacklogCount(): Promise<number> {
    const counts = await this.inboundQueue.getJobCounts();
    return counts.active + counts.waiting + counts.delayed;
  }
}

export function createQueueService(
  config: Config,
  cache: ICacheService,
  logger: ILogger,
): IQueueService {
  return new QueueService(config, cache, logger);
}
