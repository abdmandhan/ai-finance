import type { ScheduleStateType } from '@/graphs/schedule.state';
import { DEFAULT_DURATION_MINUTES, emitProgress, NODES, type ScheduleDeps } from './shared';

/** Query the calendar tool for candidate slots. */
export function makeSearchCalendarNode(deps: ScheduleDeps) {
  return {
    name: NODES.searchCalendar,
    node: async (state: ScheduleStateType) => {
      emitProgress(deps, state.threadId, 'search_calendar', 'Checking availability...');

      try {
        const auth = await deps.resolveAuth(state.tenantId);
        const slots = await deps.calendarTool.searchAvailability(auth, {
          durationMinutes: state.durationMinutes ?? DEFAULT_DURATION_MINUTES,
          timeframe: state.timeframe ?? undefined,
          timezone: state.timezone ?? undefined,
        });
        return { availableSlots: slots, _nextNode: NODES.findSlot };
      } catch (err) {
        deps.logger.error({ err }, 'search-calendar failed');
        return {
          result: {
            status: 'failed' as const,
            summary: 'Could not read your calendar. Please try again later.',
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
