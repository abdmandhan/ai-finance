import {
  makeAskPaymentClarificationNode,
  makeExecutePaymentNode,
  makeFinalizePaymentNode,
  makeParsePaymentNode,
  makePaymentApprovalNode,
  makeResolvePaymentTargetNode,
  PAYMENT_NODES,
  type PaymentDeps,
} from "@/nodes";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, START, StateGraph } from "@langchain/langgraph";
import { PaymentState, type PaymentStateType } from "./payment.state";

export type PaymentGraph = ReturnType<typeof buildPaymentGraph>;

function routeByNextNode(state: PaymentStateType): string {
  return state._nextNode ?? END;
}

function pathMap(...names: string[]): Record<string, string> {
  return Object.fromEntries([...names, END].map((n) => [n, n]));
}

/**
 * Payments / credit notes / reversals / voids against existing Xero documents.
 * Every write is immediately effective, so the approval interrupt sits BEFORE
 * `execute_payment` — the only node that touches Xero in write mode.
 */
export function buildPaymentGraph(
  deps: PaymentDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const parse = makeParsePaymentNode(deps);
  const clarify = makeAskPaymentClarificationNode(deps);
  const resolveTarget = makeResolvePaymentTargetNode(deps);
  const approval = makePaymentApprovalNode(deps);
  const execute = makeExecutePaymentNode(deps);
  const finalize = makeFinalizePaymentNode(deps);

  const graph = new StateGraph(PaymentState)
    .addNode(parse.name, parse.node)
    .addNode(clarify.name, clarify.node)
    .addNode(resolveTarget.name, resolveTarget.node)
    .addNode(approval.name, approval.node)
    .addNode(execute.name, execute.node)
    .addNode(finalize.name, finalize.node)
    .addEdge(START, PAYMENT_NODES.parsePayment)
    .addConditionalEdges(
      PAYMENT_NODES.parsePayment,
      routeByNextNode,
      pathMap(
        PAYMENT_NODES.askClarification,
        PAYMENT_NODES.resolveTarget,
        PAYMENT_NODES.finalize,
      ),
    )
    .addEdge(PAYMENT_NODES.askClarification, PAYMENT_NODES.parsePayment)
    .addConditionalEdges(
      PAYMENT_NODES.resolveTarget,
      routeByNextNode,
      pathMap(
        PAYMENT_NODES.approval,
        PAYMENT_NODES.askClarification,
        PAYMENT_NODES.finalize,
      ),
    )
    .addConditionalEdges(
      PAYMENT_NODES.approval,
      routeByNextNode,
      pathMap(PAYMENT_NODES.execute, PAYMENT_NODES.finalize),
    )
    .addEdge(PAYMENT_NODES.execute, PAYMENT_NODES.finalize)
    .addEdge(PAYMENT_NODES.finalize, END);

  return graph.compile({ checkpointer });
}
