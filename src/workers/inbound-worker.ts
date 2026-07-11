import type { Config, ILogger } from "@/commons";
import type { InboundMessage } from "@/schemas";
import type { IKafkaService, IQueueService, MessageHandler } from "@/services";
import { Worker, type ReservedJob } from "groupmq";

export interface InboundWorker {
  start(): Promise<void>;
  /** Drain in-flight jobs (up to 10s) and close. */
  stop(): Promise<void>;
}

export interface InboundWorkerDeps {
  queueService: IQueueService;
  kafka: IKafkaService;
  logger: ILogger;
  config: Config;
  /** The same MessageHandler the direct path uses (legacy or assistant). */
  handle: MessageHandler;
}

/**
 * Consumes queued inbound jobs with concurrency + retry. The job payload is
 * re-serialized so the existing `MessageHandler(raw)` contract runs unmodified
 * whether messages arrive queued or direct. Exhausted retries dead-letter to
 * chat.inbound.error via onError.
 */
export function createInboundWorker(deps: InboundWorkerDeps): InboundWorker {
  const { queueService, kafka, config, handle } = deps;
  const logger = deps.logger.child({ name: "InboundWorker" });

  const worker = new Worker<InboundMessage>({
    queue: queueService.inbound(),
    concurrency: config.worker.concurrency,
    maxAttempts: config.worker.max_attempts,
    backoff: (attempt) => attempt * 500,
    logger,
    handler: async (job: ReservedJob<InboundMessage>) => {
      await handle(JSON.stringify(job.data));
    },
    onError: async (err, job) => {
      logger.error(
        { err, requestId: job?.data?.requestId },
        "job failed — dead-lettering",
      );
      await kafka
        .publishInboundError(job?.data?.chatId ?? "", {
          error: err,
          data: job?.data,
        })
        .catch((publishErr) =>
          logger.error({ err: publishErr }, "publishInboundError failed"),
        );
    },
  });

  return {
    async start(): Promise<void> {
      logger.info(
        { concurrency: config.worker.concurrency },
        "Starting inbound worker",
      );
      void worker.run();
    },

    async stop(): Promise<void> {
      await worker.close(10_000);
      logger.info("Inbound worker stopped");
    },
  };
}
