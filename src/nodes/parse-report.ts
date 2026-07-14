import type { ReportStateType } from "@/graphs/report.state";
import { reportPrompts } from "@/prompts";
import { reportIntentSchema } from "@/schemas";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  REPORT_NODES,
  type ReportDeps,
} from "./shared";

/** Classify the financial question and extract its parameters. Read-only routing. */
export function makeParseReportNode(deps: ReportDeps) {
  return {
    name: REPORT_NODES.parseReport,
    node: async (state: ReportStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "parse_report",
        "Understanding the question...",
      );
      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
      const extracted = await deps.llmService.extract(
        reportIntentSchema,
        [
          new SystemMessage(reportPrompts.parseReportPrompt(today)),
          new HumanMessage(state.userMessage),
        ],
        "report_intent",
      );
      deps.logger.info({ extracted }, "parse-report result");

      if (extracted.metric === "unsupported") {
        return {
          metric: extracted.metric,
          result: {
            status: "failed" as const,
            summary:
              "I can't answer that from Xero data. I can report on expenses, revenue, profit, cash, the balance sheet, and invoice or bill lists by status.",
          },
          _nextNode: REPORT_NODES.finalize,
        };
      }

      if (
        extracted.clarificationQuestion &&
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
      ) {
        return {
          metric: extracted.metric,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: REPORT_NODES.askClarification,
        };
      }

      return {
        metric: extracted.metric,
        periodToken: extracted.periodToken,
        customFrom: extracted.from,
        customTo: extracted.to,
        compareToPrevious: extracted.compareToPrevious,
        groupBy: extracted.groupBy,
        contactName: extracted.contactName,
        minAmount: extracted.minAmount,
        topN: extracted.topN,
        clarificationQuestion: null,
        _nextNode: REPORT_NODES.resolvePeriod,
      };
    },
  };
}
