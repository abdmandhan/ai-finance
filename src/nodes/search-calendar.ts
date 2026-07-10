import type { ScheduleStateType } from '@/graphs/schedule.state';
import { DEFAULT_DURATION_MINUTES, emitProgress, NODES, type ScheduleDeps } from './shared';

/** Query the calendar tool for candidate slots. */
export function makeSearchCalendarNode(deps: ScheduleDeps) {
  return {
    name: NODES.searchCalendar,
    node: async (state: ScheduleStateType) => {
      emitProgress(deps, state.threadId, 'search_calendar', 'Checking availability...');

      const slots = await deps.calendarTool.searchAvailability({
        attendee: state.attendee ?? '',
        durationMinutes: state.durationMinutes ?? DEFAULT_DURATION_MINUTES,
        timeframe: state.timeframe ?? '',
      });

      return { availableSlots: slots, _nextNode: NODES.findSlot };
    },
  };
}
