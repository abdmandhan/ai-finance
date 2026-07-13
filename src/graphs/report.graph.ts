import {
  makeAskReportClarificationNode,
  makeComposeReportAnswerNode,
  makeFetchReportDataNode,
  makeFinalizeReportNode,
  makeParseReportNode,
  makeResolveReportPeriodNode,
  REPORT_NODES,
  type ReportDeps,
} from "@/nodes";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ReportState, type ReportStateType } from "./report.state";

export type ReportGraph = ReturnType<typeof buildReportGraph>;

function routeByNextNode(state: ReportStateType): string {
  return state._nextNode ?? END;
}

function pathMap(...names: string[]): Record<string, string> {
  return Object.fromEntries([...names, END].map((n) => [n, n]));
}

/**
 * Read-only financial Q&A. There is deliberately NO approval node in this graph —
 * it can only clarify, never write (XERO-AI-007 by construction).
 */
export function buildReportGraph(
  deps: ReportDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const parse = makeParseReportNode(deps);
  const clarify = makeAskReportClarificationNode(deps);
  const resolvePeriod = makeResolveReportPeriodNode(deps);
  const fetchData = makeFetchReportDataNode(deps);
  const compose = makeComposeReportAnswerNode(deps);
  const finalize = makeFinalizeReportNode(deps);

  const graph = new StateGraph(ReportState)
    .addNode(parse.name, parse.node)
    .addNode(clarify.name, clarify.node)
    .addNode(resolvePeriod.name, resolvePeriod.node)
    .addNode(fetchData.name, fetchData.node)
    .addNode(compose.name, compose.node)
    .addNode(finalize.name, finalize.node)
    .addEdge(START, REPORT_NODES.parseReport)
    .addConditionalEdges(
      REPORT_NODES.parseReport,
      routeByNextNode,
      pathMap(
        REPORT_NODES.askClarification,
        REPORT_NODES.resolvePeriod,
        REPORT_NODES.finalize,
      ),
    )
    .addEdge(REPORT_NODES.askClarification, REPORT_NODES.parseReport)
    .addEdge(REPORT_NODES.resolvePeriod, REPORT_NODES.fetchData)
    .addConditionalEdges(
      REPORT_NODES.fetchData,
      routeByNextNode,
      pathMap(REPORT_NODES.composeAnswer, REPORT_NODES.finalize),
    )
    .addEdge(REPORT_NODES.composeAnswer, REPORT_NODES.finalize)
    .addEdge(REPORT_NODES.finalize, END);

  return graph.compile({ checkpointer });
}
