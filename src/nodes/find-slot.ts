import type { ScheduleStateType } from '@/graphs/schedule.state';
import { emitProgress, NODES, type ScheduleDeps } from './shared';

/**
 * Deterministically pick a slot (earliest available). Kept as code, not an LLM
 * call — the planner decides, code validates.
 */
export function makeFindSlotNode(deps: ScheduleDeps) {
  return {
    name: NODES.findSlot,
    node: async (state: ScheduleStateType) => {
      const slots = state.availableSlots ?? [];

      if (slots.length === 0) {
        return {
          result: {
            status: 'failed' as const,
            summary: 'No available slots were found for the requested timeframe.',
          },
          _nextNode: NODES.finalize,
        };
      }

      const selectedSlot = slots[0];
      emitProgress(deps, state.threadId, 'find_slot', `Booking ${selectedSlot.start}`);

      // No approval gate — go straight to creating the event.
      return { selectedSlot, _nextNode: NODES.createEvent };
    },
  };
}
