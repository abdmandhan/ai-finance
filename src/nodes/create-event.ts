import type { ScheduleStateType } from '@/graphs/schedule.state';
import { emitProgress, NODES, type ScheduleDeps } from './shared';

/** Create the calendar event via the tool. Only reached after approval. */
export function makeCreateEventNode(deps: ScheduleDeps) {
  return {
    name: NODES.createEvent,
    node: async (state: ScheduleStateType) => {
      // Guard: never create without approval, even if wiring changes.
      if (!state.approved || !state.selectedSlot) {
        return {
          result: {
            status: 'failed' as const,
            summary: 'Cannot create event without an approved slot.',
          },
          _nextNode: NODES.finalize,
        };
      }

      emitProgress(deps, state.threadId, 'create_event', 'Creating the meeting...');

      const summary = `Meeting with ${state.attendee}`;
      const { eventId } = await deps.calendarTool.createEvent({
        attendee: state.attendee ?? '',
        slot: state.selectedSlot,
        summary,
      });

      return {
        result: {
          status: 'created' as const,
          eventId,
          summary: `${summary} scheduled for ${state.selectedSlot.start}`,
        },
        _nextNode: NODES.notify,
      };
    },
  };
}
