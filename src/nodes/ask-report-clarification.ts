import type { ReportStateType } from "@/graphs/report.state";
import { interrupt } from "@langchain/langgraph";
import {
  REPORT_NODES,
  type InterruptPayload,
  type ReportDeps,
  type ResumeInput,
} from "./shared";

/** Pause and ask for the missing detail; fold the reply back in and re-parse. */
export function makeAskReportClarificationNode(deps: ReportDeps) {
  return {
    name: REPORT_NODES.askClarification,
    node: async (state: ReportStateType) => {
      const question =
        state.clarificationQuestion ?? "Could you clarify the question?";
      const payload: InterruptPayload = {
        kind: "clarification",
        message: question,
      };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);
      deps.logger.info({ reply }, "report clarification reply");

      return {
        userMessage: `${state.userMessage}\n${reply.reply ?? ""}`,
        clarificationQuestion: null,
        clarifyAttempts: state.clarifyAttempts + 1,
        _nextNode: undefined,
      };
    },
  };
}
