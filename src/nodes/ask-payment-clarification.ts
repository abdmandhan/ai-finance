import type { PaymentStateType } from "@/graphs/payment.state";
import { interrupt } from "@langchain/langgraph";
import {
  PAYMENT_NODES,
  type InterruptPayload,
  type PaymentDeps,
  type ResumeInput,
} from "./shared";

/** Pause and ask for missing payment info; fold the reply back in and re-parse. */
export function makeAskPaymentClarificationNode(deps: PaymentDeps) {
  return {
    name: PAYMENT_NODES.askClarification,
    node: async (state: PaymentStateType) => {
      const question =
        state.clarificationQuestion ?? "Could you provide more details?";
      const payload: InterruptPayload = {
        kind: "clarification",
        message: question,
      };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);
      deps.logger.info({ reply }, "payment clarification reply");

      return {
        userMessage: `${state.userMessage}\n${reply.reply ?? ""}`,
        clarificationQuestion: null,
        clarifyAttempts: state.clarifyAttempts + 1,
        _nextNode: undefined,
      };
    },
  };
}
