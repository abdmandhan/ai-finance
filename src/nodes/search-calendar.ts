import type { ScheduleStateType } from '@/graphs/schedule.state';
import {
  detectConflicts,
  findFreeSlots,
  isPhysical,
  type BusyEvent,
  type SchedulingPrefs,
} from '@/commons';
import type { CalendarEvent, IMapsTool } from '@/tools';
import { DEFAULT_DURATION_MINUTES, emitProgress, NODES, type ScheduleDeps } from './shared';

/** UTC calendar-day bounds for an instant (used to list that day's events). */
function dayBoundsUtc(iso: string): { min: string; max: string } {
  const d = new Date(Date.parse(iso));
  d.setUTCHours(0, 0, 0, 0);
  return { min: d.toISOString(), max: new Date(d.getTime() + 24 * 3_600_000).toISOString() };
}

/** Attach travel time (to the new meeting's location) as a trailing pad on each physical event. */
async function padTravel(
  events: CalendarEvent[],
  location: string | null | undefined,
  maps: IMapsTool,
): Promise<BusyEvent[]> {
  if (!isPhysical(location)) return events.map((e) => ({ start: e.start, end: e.end }));
  return Promise.all(
    events.map(async (e): Promise<BusyEvent> => {
      if (isPhysical(e.location)) {
        try {
          const tt = await maps.travelTime(e.location, location);
          if (tt) return { start: e.start, end: e.end, travelTimeAfterMs: tt.durationMinutes * 60_000 };
        } catch {
          // Maps error → fall back to buffer-only for this event.
        }
      }
      return { start: e.start, end: e.end };
    }),
  );
}

/**
 * Resolve the slot to book. Lists existing events, then:
 *  - requested time → check overlap + travel from the adjacent event; on conflict/too-tight,
 *    propose alternatives instead of double-booking; otherwise book it.
 *  - vague timeframe → find free slots (buffer + travel + working hours) over the next 2 weeks.
 */
export function makeSearchCalendarNode(deps: ScheduleDeps) {
  return {
    name: NODES.searchCalendar,
    node: async (state: ScheduleStateType) => {
      const durationMinutes = state.durationMinutes ?? DEFAULT_DURATION_MINUTES;
      const durMs = durationMinutes * 60_000;
      const bufferMs = deps.schedulingPrefs.bufferMinutes * 60_000;
      const prefs: SchedulingPrefs = {
        bufferMinutes: deps.schedulingPrefs.bufferMinutes,
        workingHoursStart: deps.schedulingPrefs.workingHoursStart,
        workingHoursEnd: deps.schedulingPrefs.workingHoursEnd,
        timezone: state.timezone ?? deps.defaultTimezone,
      };

      try {
        const auth = await deps.resolveAuth(state.tenantId);

        // ── Requested specific time ─────────────────────────────────────
        if (state.requestedStartIso) {
          const reqStartMs = Date.parse(state.requestedStartIso);
          if (Number.isNaN(reqStartMs)) {
            return {
              result: { status: 'failed' as const, summary: 'Could not understand the requested date/time.' },
              _nextNode: NODES.finalize,
            };
          }
          const reqStart = new Date(reqStartMs).toISOString();
          const reqEnd = new Date(reqStartMs + durMs).toISOString();
          emitProgress(deps, state.threadId, 'search_calendar', `Checking ${reqStart}`);

          const { min, max } = dayBoundsUtc(reqStart);
          const events = await deps.calendarTool.listEvents(auth, min, max);

          const conflicts = detectConflicts(events, reqStart, reqEnd);

          // Travel feasibility from the event immediately before the requested time.
          let travelShortfall = false;
          if (isPhysical(state.location)) {
            const prev = events
              .filter((e) => Date.parse(e.end) <= reqStartMs && isPhysical(e.location))
              .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
            if (prev) {
              const tt = await deps.mapsTool.travelTime(prev.location as string, state.location as string);
              const needMs = Math.max(bufferMs, tt ? tt.durationMinutes * 60_000 : 0);
              if (reqStartMs - Date.parse(prev.end) < needMs) travelShortfall = true;
            }
          }

          if (conflicts.length > 0 || travelShortfall) {
            const eventsTravel = await padTravel(events, state.location, deps.mapsTool);
            const suggestedSlots = findFreeSlots(eventsTravel, reqStart, max, durationMinutes, prefs, 3);
            const reason = conflicts.length
              ? 'That time overlaps an existing event.'
              : 'That leaves too little travel time before the meeting.';
            return {
              suggestedSlots,
              result: {
                status: 'proposed' as const,
                summary: reason,
                suggestedSlots,
              },
              _nextNode: NODES.finalize,
            };
          }

          emitProgress(deps, state.threadId, 'search_calendar', `Booking ${reqStart}`);
          return { selectedSlot: { start: reqStart, end: reqEnd }, _nextNode: NODES.createEvent };
        }

        // ── Vague timeframe → free-slot scan over the next 2 weeks ───────
        emitProgress(deps, state.threadId, 'search_calendar', 'Checking availability...');
        const windowStart = new Date().toISOString();
        const windowEnd = new Date(Date.now() + 14 * 24 * 3_600_000).toISOString();
        const events = await deps.calendarTool.listEvents(auth, windowStart, windowEnd);
        const eventsTravel = await padTravel(events, state.location, deps.mapsTool);
        const slots = findFreeSlots(eventsTravel, windowStart, windowEnd, durationMinutes, prefs, 3);

        if (slots.length === 0) {
          return {
            result: { status: 'failed' as const, summary: 'No free slots were found in the next two weeks.' },
            _nextNode: NODES.finalize,
          };
        }
        return { availableSlots: slots, _nextNode: NODES.findSlot };
      } catch (err) {
        deps.logger.error({ err }, 'search-calendar failed');
        return {
          result: { status: 'failed' as const, summary: 'Could not read your calendar. Please try again later.' },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
