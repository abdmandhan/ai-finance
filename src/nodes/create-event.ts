import type { ScheduleStateType } from '@/graphs/schedule.state';
import { emitProgress, NODES, type ScheduleDeps } from './shared';

/**
 * Create the calendar event immediately — no approval gate (mirrors the Agent, which
 * writes the event on the calendar the moment the tool runs). The approval record is
 * emitted post-hoc by the runtime driver, not held here.
 */
export function makeCreateEventNode(deps: ScheduleDeps) {
  return {
    name: NODES.createEvent,
    node: async (state: ScheduleStateType) => {
      if (!state.selectedSlot) {
        return {
          result: { status: 'failed' as const, summary: 'No slot selected to create.' },
          _nextNode: NODES.finalize,
        };
      }

      emitProgress(deps, state.threadId, 'create_event', 'Creating the meeting...');
      const summary = `Meeting with ${state.attendee}`;

      try {
        const auth = await deps.resolveAuth(state.tenantId);
        const { eventId, htmlLink } = await deps.calendarTool.createEvent(auth, {
          summary,
          start: state.selectedSlot.start,
          end: state.selectedSlot.end,
          timeZone: state.timezone ?? undefined,
          attendees: state.attendeeEmail
            ? [{ email: state.attendeeEmail, name: state.attendee ?? undefined }]
            : undefined,
        });

        return {
          result: {
            status: 'created' as const,
            eventId,
            htmlLink,
            summary: `${summary} scheduled for ${state.selectedSlot.start}`,
          },
          _nextNode: NODES.notify,
        };
      } catch (err) {
        deps.logger.error({ err }, 'create-event failed');
        return {
          result: {
            status: 'failed' as const,
            summary: 'Could not create the calendar event. Please try again later.',
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
