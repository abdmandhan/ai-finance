import {
  INVOICE_NODES,
  makeAskInvoiceClarificationNode,
  makeAttachInvoiceFileNode,
  makeAuthoriseInvoiceNode,
  makeCheckDuplicateInvoiceNode,
  makeCreateDraftInvoiceNode,
  makeFinalizeInvoiceNode,
  makeInvoiceApprovalNode,
  makeParseInvoiceNode,
  makeResolveXeroContactNode,
  type InvoiceDeps,
} from "@/nodes";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, START, StateGraph } from "@langchain/langgraph";
import { InvoiceState, type InvoiceStateType } from "./invoice.state";
import { traceGraphNode } from "./trace-node";

export type InvoiceGraph = ReturnType<typeof buildInvoiceGraph>;

function routeByNextNode(state: InvoiceStateType): string {
  return state._nextNode ?? END;
}

function pathMap(...names: string[]): Record<string, string> {
  return Object.fromEntries([...names, END].map((n) => [n, n]));
}

export function buildInvoiceGraph(
  deps: InvoiceDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const parse = traceGraphNode(deps, "invoice", makeParseInvoiceNode(deps));
  const clarify = traceGraphNode(
    deps,
    "invoice",
    makeAskInvoiceClarificationNode(deps),
  );
  const resolveContact = traceGraphNode(
    deps,
    "invoice",
    makeResolveXeroContactNode(deps),
  );
  const checkDuplicate = traceGraphNode(
    deps,
    "invoice",
    makeCheckDuplicateInvoiceNode(deps),
  );
  const createDraft = traceGraphNode(
    deps,
    "invoice",
    makeCreateDraftInvoiceNode(deps),
  );
  const attach = traceGraphNode(deps, "invoice", makeAttachInvoiceFileNode(deps));
  const approval = traceGraphNode(deps, "invoice", makeInvoiceApprovalNode(deps));
  const authorise = traceGraphNode(
    deps,
    "invoice",
    makeAuthoriseInvoiceNode(deps),
  );
  const finalize = traceGraphNode(deps, "invoice", makeFinalizeInvoiceNode(deps));

  const graph = new StateGraph(InvoiceState)
    .addNode(parse.name, parse.node)
    .addNode(clarify.name, clarify.node)
    .addNode(resolveContact.name, resolveContact.node)
    .addNode(checkDuplicate.name, checkDuplicate.node)
    .addNode(createDraft.name, createDraft.node)
    .addNode(attach.name, attach.node)
    .addNode(approval.name, approval.node)
    .addNode(authorise.name, authorise.node)
    .addNode(finalize.name, finalize.node)
    .addEdge(START, INVOICE_NODES.parseInvoice)
    .addConditionalEdges(
      INVOICE_NODES.parseInvoice,
      routeByNextNode,
      pathMap(
        INVOICE_NODES.askClarification,
        INVOICE_NODES.resolveContact,
        INVOICE_NODES.finalize,
      ),
    )
    .addEdge(INVOICE_NODES.askClarification, INVOICE_NODES.parseInvoice)
    .addConditionalEdges(
      INVOICE_NODES.resolveContact,
      routeByNextNode,
      pathMap(INVOICE_NODES.checkDuplicate, INVOICE_NODES.finalize),
    )
    .addConditionalEdges(
      INVOICE_NODES.checkDuplicate,
      routeByNextNode,
      pathMap(INVOICE_NODES.createDraft, INVOICE_NODES.finalize),
    )
    .addConditionalEdges(
      INVOICE_NODES.createDraft,
      routeByNextNode,
      pathMap(INVOICE_NODES.attach, INVOICE_NODES.finalize),
    )
    .addEdge(INVOICE_NODES.attach, INVOICE_NODES.approval)
    .addConditionalEdges(
      INVOICE_NODES.approval,
      routeByNextNode,
      pathMap(INVOICE_NODES.authorise, INVOICE_NODES.finalize),
    )
    .addEdge(INVOICE_NODES.authorise, INVOICE_NODES.finalize)
    .addEdge(INVOICE_NODES.finalize, END);

  return graph.compile({ checkpointer });
}
