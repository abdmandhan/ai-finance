import {
  makeAskClarificationNode,
  makeAwaitResolutionNode,
  makeCreateEventNode,
  makeFinalizeNode,
  makeFindSlotNode,
  makeListPreferencesNode,
  makeLookupScheduleNode,
  makeNotifyNode,
  makeParseIntentNode,
  makeResolveContactNode,
  makeSaveContactNode,
  makeSavePreferenceNode,
  makeSearchCalendarNode,
  NODES,
  type ScheduleDeps,
} from "@/nodes";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ScheduleState, type ScheduleStateType } from "./schedule.state";
import { traceGraphNode } from "./trace-node";

export type ScheduleGraph = ReturnType<typeof buildScheduleGraph>;

/** Route on the ephemeral `_nextNode` signal; default to END. */
function routeByNextNode(state: ScheduleStateType): string {
  return state._nextNode ?? END;
}

/** Build a `{name: name}` path map (plus END) for conditional edges. */
function pathMap(...names: string[]): Record<string, string> {
  return Object.fromEntries([...names, END].map((n) => [n, n]));
}

export function buildScheduleGraph(
  deps: ScheduleDeps,
  checkpointer?: BaseCheckpointSaver,
) {
  const parseIntent = traceGraphNode(deps, "schedule", makeParseIntentNode(deps));
  const askClarification = traceGraphNode(
    deps,
    "schedule",
    makeAskClarificationNode(deps),
  );
  const resolveContact = traceGraphNode(
    deps,
    "schedule",
    makeResolveContactNode(deps),
  );
  const searchCalendar = traceGraphNode(
    deps,
    "schedule",
    makeSearchCalendarNode(deps),
  );
  const lookupSchedule = traceGraphNode(
    deps,
    "schedule",
    makeLookupScheduleNode(deps),
  );
  const findSlot = traceGraphNode(deps, "schedule", makeFindSlotNode(deps));
  const awaitResolution = traceGraphNode(
    deps,
    "schedule",
    makeAwaitResolutionNode(deps),
  );
  const createEvent = traceGraphNode(deps, "schedule", makeCreateEventNode(deps));
  const saveContact = traceGraphNode(deps, "schedule", makeSaveContactNode(deps));
  const savePreference = traceGraphNode(
    deps,
    "schedule",
    makeSavePreferenceNode(deps),
  );
  const listPreferences = traceGraphNode(
    deps,
    "schedule",
    makeListPreferencesNode(deps),
  );
  const notify = traceGraphNode(deps, "schedule", makeNotifyNode(deps));
  const finalize = traceGraphNode(deps, "schedule", makeFinalizeNode(deps));

  const graph = new StateGraph(ScheduleState)
    .addNode(parseIntent.name, parseIntent.node)
    .addNode(askClarification.name, askClarification.node)
    .addNode(resolveContact.name, resolveContact.node)
    .addNode(searchCalendar.name, searchCalendar.node)
    .addNode(lookupSchedule.name, lookupSchedule.node)
    .addNode(findSlot.name, findSlot.node)
    .addNode(awaitResolution.name, awaitResolution.node)
    .addNode(createEvent.name, createEvent.node)
    .addNode(saveContact.name, saveContact.node)
    .addNode(savePreference.name, savePreference.node)
    .addNode(listPreferences.name, listPreferences.node)
    .addNode(notify.name, notify.node)
    .addNode(finalize.name, finalize.node)
    .addEdge(START, NODES.parseIntent)
    .addConditionalEdges(
      NODES.parseIntent,
      routeByNextNode,
      pathMap(
        NODES.askClarification,
        NODES.resolveContact,
        NODES.lookupSchedule,
        NODES.saveContact,
        NODES.savePreference,
        NODES.listPreferences,
        NODES.finalize,
      ),
    )
    // After a clarification reply, re-parse with the enriched message.
    .addEdge(NODES.askClarification, NODES.parseIntent)
    // Lookup answers directly, then ends.
    .addEdge(NODES.lookupSchedule, NODES.finalize)
    .addConditionalEdges(
      NODES.saveContact,
      routeByNextNode,
      pathMap(NODES.askClarification, NODES.finalize),
    )
    .addConditionalEdges(
      NODES.savePreference,
      routeByNextNode,
      pathMap(NODES.askClarification, NODES.finalize),
    )
    .addEdge(NODES.listPreferences, NODES.finalize)
    .addConditionalEdges(
      NODES.resolveContact,
      routeByNextNode,
      pathMap(NODES.askClarification, NODES.searchCalendar, NODES.finalize),
    )
    .addConditionalEdges(
      NODES.searchCalendar,
      routeByNextNode,
      pathMap(
        NODES.findSlot,
        NODES.createEvent,
        NODES.awaitResolution,
        NODES.finalize,
      ),
    )
    .addConditionalEdges(
      NODES.findSlot,
      routeByNextNode,
      pathMap(NODES.createEvent, NODES.finalize),
    )
    // The principal picks a resolution: book an option / accept / revalidate a
    // change (back to search) / re-ask (self-loop, bounded) / end.
    .addConditionalEdges(
      NODES.awaitResolution,
      routeByNextNode,
      pathMap(
        NODES.createEvent,
        NODES.searchCalendar,
        NODES.awaitResolution,
        NODES.finalize,
      ),
    )
    .addConditionalEdges(
      NODES.createEvent,
      routeByNextNode,
      pathMap(NODES.notify, NODES.finalize),
    )
    .addEdge(NODES.notify, NODES.finalize)
    .addEdge(NODES.finalize, END);

  return graph.compile({ checkpointer });
}
