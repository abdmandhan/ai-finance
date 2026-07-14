import {
  EXPENSE_NODES,
  makeAskExpenseClarificationNode,
  makeAttachExpenseFileNode,
  makeExecuteExpenseNode,
  makeExpenseApprovalNode,
  makeFinalizeExpenseNode,
  makeParseExpenseNode,
  makeResolveBankAccountsNode,
  type ExpenseDeps,
} from "@/nodes";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ExpenseState, type ExpenseStateType } from "./expense.state";
import { traceGraphNode } from "./trace-node";

export type ExpenseGraph = ReturnType<typeof buildExpenseGraph>;

function routeByNextNode(state: ExpenseStateType): string {
  return state._nextNode ?? END;
}

function pathMap(...names: string[]): Record<string, string> {
  return Object.fromEntries([...names, END].map((n) => [n, n]));
}

/**
 * Spend/receive money + bank transfers. Immediately-effective writes, so the
 * approval interrupt sits BEFORE `execute_expense`; receipts attach afterwards.
 */
export function buildExpenseGraph(
  deps: ExpenseDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const parse = traceGraphNode(deps, "expense", makeParseExpenseNode(deps));
  const clarify = traceGraphNode(
    deps,
    "expense",
    makeAskExpenseClarificationNode(deps),
  );
  const resolveAccounts = traceGraphNode(
    deps,
    "expense",
    makeResolveBankAccountsNode(deps),
  );
  const approval = traceGraphNode(deps, "expense", makeExpenseApprovalNode(deps));
  const execute = traceGraphNode(deps, "expense", makeExecuteExpenseNode(deps));
  const attach = traceGraphNode(deps, "expense", makeAttachExpenseFileNode(deps));
  const finalize = traceGraphNode(deps, "expense", makeFinalizeExpenseNode(deps));

  const graph = new StateGraph(ExpenseState)
    .addNode(parse.name, parse.node)
    .addNode(clarify.name, clarify.node)
    .addNode(resolveAccounts.name, resolveAccounts.node)
    .addNode(approval.name, approval.node)
    .addNode(execute.name, execute.node)
    .addNode(attach.name, attach.node)
    .addNode(finalize.name, finalize.node)
    .addEdge(START, EXPENSE_NODES.parseExpense)
    .addConditionalEdges(
      EXPENSE_NODES.parseExpense,
      routeByNextNode,
      pathMap(
        EXPENSE_NODES.askClarification,
        EXPENSE_NODES.resolveAccounts,
        EXPENSE_NODES.finalize,
      ),
    )
    .addEdge(EXPENSE_NODES.askClarification, EXPENSE_NODES.parseExpense)
    .addConditionalEdges(
      EXPENSE_NODES.resolveAccounts,
      routeByNextNode,
      pathMap(
        EXPENSE_NODES.approval,
        EXPENSE_NODES.askClarification,
        EXPENSE_NODES.finalize,
      ),
    )
    .addConditionalEdges(
      EXPENSE_NODES.approval,
      routeByNextNode,
      pathMap(EXPENSE_NODES.execute, EXPENSE_NODES.finalize),
    )
    .addConditionalEdges(
      EXPENSE_NODES.execute,
      routeByNextNode,
      pathMap(EXPENSE_NODES.attach, EXPENSE_NODES.finalize),
    )
    .addEdge(EXPENSE_NODES.attach, EXPENSE_NODES.finalize)
    .addEdge(EXPENSE_NODES.finalize, END);

  return graph.compile({ checkpointer });
}
