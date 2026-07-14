import {
  ASSISTANT_NODES,
  makeAssistantCallModelNode,
  makeAssistantExecuteToolsNode,
  type AssistantDeps,
} from "@/nodes";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, START, StateGraph } from "@langchain/langgraph";
import { AssistantState, type AssistantStateType } from "./assistant.state";
import { traceGraphNode } from "./trace-node";

export type AssistantGraph = ReturnType<typeof buildAssistantGraph>;

/** Route on the ephemeral `_nextNode` signal; default to END. */
function routeByNextNode(state: AssistantStateType): string {
  return state._nextNode ?? END;
}

/** Build a `{name: name}` path map (plus END) for conditional edges. */
function pathMap(...names: string[]): Record<string, string> {
  return Object.fromEntries([...names, END].map((n) => [n, n]));
}

/**
 * The main assistant graph: a conversational agent loop over the checkpointed
 * `assistant:<chatId>` thread. Strict workflow graphs stay OUTSIDE this graph —
 * the tool-executor node invokes them on their own threads via `runWorkflow`.
 */
export function buildAssistantGraph(
  deps: AssistantDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const callModel = traceGraphNode(
    deps,
    "assistant",
    makeAssistantCallModelNode(deps),
  );
  const executeTools = traceGraphNode(
    deps,
    "assistant",
    makeAssistantExecuteToolsNode(deps),
  );

  const graph = new StateGraph(AssistantState)
    .addNode(callModel.name, callModel.node)
    .addNode(executeTools.name, executeTools.node)
    .addEdge(START, ASSISTANT_NODES.callModel)
    .addConditionalEdges(
      ASSISTANT_NODES.callModel,
      routeByNextNode,
      pathMap(ASSISTANT_NODES.executeTools),
    )
    .addEdge(ASSISTANT_NODES.executeTools, ASSISTANT_NODES.callModel);

  return graph.compile({ checkpointer });
}
