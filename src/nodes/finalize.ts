import type { ScheduleStateType } from '@/graphs/schedule.state';
import { NODES, type ScheduleDeps } from './shared';

/**
 * Terminal node. Guarantees a `result` is set so the runtime can always publish
 * a result event.
 */
export function makeFinalizeNode(deps: ScheduleDeps) {
  return {
    name: NODES.finalize,
    node: async (state: ScheduleStateType) => {
      const result = state.result ?? {
        status: 'failed' as const,
        summary: 'Workflow ended without a result.',
      };
      deps.logger.info({ result }, 'schedule graph finished');
      return { result };
    },
  };
}
