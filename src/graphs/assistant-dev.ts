/**
 * Dev-only assistant graph entry point for the LangGraph CLI / Studio.
 * Uses a STUB workflow runner so Studio runs without Kafka, Google, or Xero:
 * every tool call "creates" instantly. No custom checkpointer — the dev server
 * manages persistence.
 */
import { configUtils, loggerUtils } from "@/commons";
import { buildAssistantGraph } from "@/graphs/assistant.graph";
// Import concrete modules (not the `@/services` barrel) so Studio does not pull in
// kafka.service.ts and load the native Kafka addon.
import { createAuditService } from "@/services/audit.service";
import { createLlmService } from "@/services/llm.service";
import type { RunWorkflow } from "@/services/workflow-runner";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const stubRunWorkflow: RunWorkflow = async (workflow, chatId, input) => {
  logger.info({ workflow, chatId, input }, "stub workflow invoked");
  return {
    kind: "result",
    workflow,
    result: {
      status: "created",
      summary: `(stub) ${workflow} workflow completed.`,
      ...(workflow === "schedule"
        ? { eventId: "stub-event-1", htmlLink: "https://calendar.example/stub" }
        : { invoiceId: "stub-invoice-1" }),
    },
  };
};

export const graph = buildAssistantGraph({
  llmService: createLlmService(config.llm, logger),
  runWorkflow: stubRunWorkflow,
  audit: createAuditService(logger),
  defaultTimezone: config.calendar.default_timezone,
  maxHistoryMessages: config.assistant.max_history_messages,
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, "progress"),
});
