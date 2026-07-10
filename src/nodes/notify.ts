import type { ScheduleStateType } from "@/graphs/schedule.state";
import { emitProgress, NODES, type ScheduleDeps } from "./shared";

/** Notify the user of the created event, then finalize. */
export function makeNotifyNode(deps: ScheduleDeps) {
  return {
    name: NODES.notify,
    node: async (state: ScheduleStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "notify",
        state.result?.summary ?? "Done",
      );
      return { _nextNode: NODES.finalize };
    },
  };
}
