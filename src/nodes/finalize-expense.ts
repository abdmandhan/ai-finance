import type { ExpenseStateType } from "@/graphs/expense.state";
import { EXPENSE_NODES, type ExpenseDeps } from "./shared";

/** Terminal node — guarantees a `result` so the runtime can always reply. */
export function makeFinalizeExpenseNode(deps: ExpenseDeps) {
  return {
    name: EXPENSE_NODES.finalize,
    node: async (state: ExpenseStateType) => {
      const result = state.result ?? {
        status: "failed" as const,
        summary: "Workflow ended without a result.",
      };
      deps.logger.info({ result }, "expense graph finished");
      return { result };
    },
  };
}
