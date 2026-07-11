import type { ILogger } from "@/commons";
import { withRetry } from "@/commons";
import type { IKafkaService, MessageHandler } from "@/services";

export interface ErrorPublishingHandlerDeps {
  inner: MessageHandler;
  kafka: IKafkaService;
  logger: ILogger;
  attempts?: number;
}

/**
 * Wrap a message handler with retry + dead-lettering. KafkaService.consume
 * swallows handler errors (log-only), so this wrapper must sit INSIDE the
 * handler to get failures onto chat.inbound.error. Used on the direct
 * (non-queue) consumption path; the queue worker dead-letters via its own
 * onError hook instead.
 */
export function createErrorPublishingHandler(
  deps: ErrorPublishingHandlerDeps,
): MessageHandler {
  const { inner, kafka, logger, attempts = 3 } = deps;

  return async function handleWithErrorTopic(raw: string): Promise<void> {
    await withRetry(() => inner(raw), {
      attempts,
      throwOnFail: false,
      onFail: async ({ error }) => {
        let data: unknown = raw;
        let chatId = "";
        try {
          data = JSON.parse(raw);
          chatId = (data as { chatId?: string }).chatId ?? "";
        } catch {
          // unparseable raw — dead-letter the string as-is
        }
        logger.error(
          { err: error, chatId },
          "inbound handler failed — dead-lettering",
        );
        await kafka
          .publishInboundError(chatId, { error, data })
          .catch((err) => logger.error({ err }, "publishInboundError failed"));
      },
    });
  };
}
