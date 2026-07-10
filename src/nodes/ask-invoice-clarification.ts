import type { InvoiceStateType } from "@/graphs/invoice.state";
import { interrupt } from "@langchain/langgraph";
import {
  INVOICE_NODES,
  type InterruptPayload,
  type InvoiceDeps,
  type ResumeInput,
} from "./shared";

/** Pause and ask for missing invoice info; fold the reply back in and re-parse. */
export function makeAskInvoiceClarificationNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.askClarification,
    node: async (state: InvoiceStateType) => {
      const question =
        state.clarificationQuestion ?? "Could you provide more details?";
      const payload: InterruptPayload = {
        kind: "clarification",
        message: question,
      };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);
      deps.logger.info({ reply }, "invoice clarification reply");

      return {
        userMessage: `${state.userMessage}\n${reply.reply ?? ""}`,
        clarificationQuestion: null,
        clarifyAttempts: state.clarifyAttempts + 1,
        _nextNode: undefined,
      };
    },
  };
}
