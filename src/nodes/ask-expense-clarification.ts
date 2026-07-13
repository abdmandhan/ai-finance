import type { ExpenseStateType } from "@/graphs/expense.state";
import { interrupt } from "@langchain/langgraph";
import {
  EXPENSE_NODES,
  type ExpenseDeps,
  type InterruptPayload,
  type ResumeInput,
} from "./shared";

/** Pause and ask for missing expense info; fold the reply back in and re-parse. */
export function makeAskExpenseClarificationNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.askClarification,
    node: async (state: ExpenseStateType) => {
      const question =
        state.clarificationQuestion ?? "Could you provide more details?";
      const payload: InterruptPayload = {
        kind: "clarification",
        message: question,
      };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);
      deps.logger.info({ reply }, "expense clarification reply");

      return {
        userMessage: `${state.userMessage}\n${reply.reply ?? ""}`,
        clarificationQuestion: null,
        clarifyAttempts: state.clarifyAttempts + 1,
        _nextNode: undefined,
      };
    },
  };
}
