import type { ScheduleStateType } from "@/graphs/schedule.state";
import {
  detectConflicts,
  findFreeSlots,
  formatEventLine,
  isFlightLike,
  isPhysical,
  slotViolation,
  type BusyEvent,
} from "@/commons";
import type { CalendarEvent, IMapsTool } from "@/tools";
import {
  DEFAULT_DURATION_MINUTES,
  emitProgress,
  mergePrefs,
  NODES,
  postArrivalBufferMinutes,
  type ScheduleDeps,
} from "./shared";

/** UTC calendar-day bounds for an instant (used to list that day's events). */
function dayBoundsUtc(iso: string): { min: string; max: string } {
  const d = new Date(Date.parse(iso));
  d.setUTCHours(0, 0, 0, 0);
  return {
    min: d.toISOString(),
    max: new Date(d.getTime() + 24 * 3_600_000).toISOString(),
  };
}

/** Attach travel time (to the new meeting's location) as a trailing pad on each physical event. */
async function padTravel(
  events: CalendarEvent[],
  location: string | null | undefined,
  maps: IMapsTool,
): Promise<BusyEvent[]> {
  if (!isPhysical(location))
    return events.map((e) => ({ start: e.start, end: e.end }));
  return Promise.all(
    events.map(async (e): Promise<BusyEvent> => {
      if (isPhysical(e.location)) {
        try {
          const tt = await maps.travelTime(e.location, location);
          if (tt)
            return {
              start: e.start,
              end: e.end,
              travelTimeAfterMs: tt.durationMinutes * 60_000,
            };
        } catch {
          // Maps error → fall back to buffer-only for this event.
        }
      }
      return { start: e.start, end: e.end };
    }),
  );
}

/** conflictEvents entries for a proposal, from calendar events. */
function toConflictEvents(events: CalendarEvent[]) {
  return events.map((e) => ({
    eventId: e.eventId,
    summary: e.summary,
    start: e.start,
    end: e.end,
    location: e.location ?? null,
  }));
}

/**
 * Resolve the slot to book. Lists existing events, then:
 *  - requested time → check saved-preference fit (unless a one-off override), overlap,
 *    and travel from the adjacent event (incl. a post-arrival buffer after flights).
 *    Any problem becomes a `proposal` held open by the await-resolution node — the
 *    principal picks the outcome; nothing is double-booked unilaterally.
 *  - vague timeframe → find free slots (buffer + travel + working hours + lunch/focus/
 *    day prefs) over the search window; an empty scan proposes the nearest later
 *    alternatives or a wider search instead of dead-ending.
 */
export function makeSearchCalendarNode(deps: ScheduleDeps) {
  return {
    name: NODES.searchCalendar,
    node: async (state: ScheduleStateType) => {
      const durationMinutes = state.durationMinutes ?? DEFAULT_DURATION_MINUTES;
      const durMs = durationMinutes * 60_000;
      // Saved user preferences over global config; an explicit request tz wins.
      const prefs = mergePrefs(
        {
          ...deps.schedulingPrefs,
          timezone: state.timezone ?? deps.defaultTimezone,
        },
        state.userPrefs,
      );
      if (state.timezone) prefs.timezone = state.timezone;
      const bufferMs = prefs.bufferMinutes * 60_000;

      try {
        const auth = await deps.resolveAuth(state.tenantId);

        // ── Requested specific time ─────────────────────────────────────
        if (state.requestedStartIso) {
          const reqStartMs = Date.parse(state.requestedStartIso);
          if (Number.isNaN(reqStartMs)) {
            return {
              result: {
                status: "failed" as const,
                summary: "Could not understand the requested date/time.",
              },
              _nextNode: NODES.finalize,
            };
          }
          const reqStart = new Date(reqStartMs).toISOString();
          const reqEnd = new Date(reqStartMs + durMs).toISOString();
          const requestedSlot = { start: reqStart, end: reqEnd };
          emitProgress(
            deps,
            state.threadId,
            "search_calendar",
            `Checking ${reqStart}`,
          );

          const { min, max } = dayBoundsUtc(reqStart);
          const events = await deps.calendarTool.listEvents(auth, min, max);

          // Saved-preference fit (skipped entirely on a one-off override; never persisted).
          const violation = state.oneOffOverride
            ? null
            : slotViolation(reqStartMs, reqStartMs + durMs, prefs);
          if (violation) {
            const eventsTravel = await padTravel(
              events,
              state.location,
              deps.mapsTool,
            );
            const options = findFreeSlots(
              eventsTravel,
              new Date(Math.max(Date.now(), Date.parse(min))).toISOString(),
              new Date(reqStartMs + 7 * 24 * 3_600_000).toISOString(),
              durationMinutes,
              prefs,
              3,
            );
            return {
              proposal: {
                kind: "preference" as const,
                reason: `That clashes with your saved preferences: ${violation.message}`,
                options,
                conflictEvents: [],
                requestedSlot,
              },
              resolutionAttempts: 0,
              _nextNode: NODES.awaitResolution,
            };
          }

          const conflicts = detectConflicts(events, reqStart, reqEnd);

          // Travel feasibility from the event immediately before the requested time —
          // physical→physical needs live travel; a flight arrival additionally needs
          // the post-arrival settling buffer.
          let travelReason: string | null = null;
          if (isPhysical(state.location)) {
            const prev = events
              .filter(
                (e) =>
                  Date.parse(e.end) <= reqStartMs &&
                  (isPhysical(e.location) || isFlightLike(e)),
              )
              .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
            if (prev) {
              const flight = isFlightLike(prev);
              let travelMs = 0;
              if (isPhysical(prev.location)) {
                const tt = await deps.mapsTool.travelTime(
                  prev.location as string,
                  state.location as string,
                );
                travelMs = tt ? tt.durationMinutes * 60_000 : 0;
              }
              const arrivalMs = flight
                ? postArrivalBufferMinutes(state.userPrefs) * 60_000
                : 0;
              const needMs = Math.max(bufferMs, travelMs) + arrivalMs;
              if (reqStartMs - Date.parse(prev.end) < needMs) {
                travelReason = flight
                  ? `That's too soon after your flight (${prev.summary}) — allowing for travel from arrival and settling time, you'd need ${Math.round(needMs / 60_000)} min.`
                  : `That leaves too little travel time from "${prev.summary}" (${prev.location}) — you'd need about ${Math.round(needMs / 60_000)} min.`;
              }
            }
          }

          if (conflicts.length > 0 || travelReason) {
            const eventsTravel = await padTravel(
              events,
              state.location,
              deps.mapsTool,
            );
            const options = findFreeSlots(
              eventsTravel,
              reqStart,
              max,
              durationMinutes,
              prefs,
              3,
            );
            // Overlaps surface BOTH sides: the requested meeting and every existing event it hits.
            const reason = conflicts.length
              ? [
                  "That time overlaps an existing event:",
                  `- Requested: ${formatEventLine({ summary: `Meeting with ${state.attendee}`, start: reqStart, end: reqEnd, location: state.location ?? undefined }, prefs.timezone)}`,
                  ...conflicts.map(
                    (c) => `- Existing: ${formatEventLine(c, prefs.timezone)}`,
                  ),
                ].join("\n")
              : (travelReason as string);
            return {
              proposal: {
                kind: conflicts.length
                  ? ("conflict" as const)
                  : ("travel" as const),
                reason,
                options,
                conflictEvents: toConflictEvents(conflicts),
                requestedSlot,
              },
              resolutionAttempts: 0,
              _nextNode: NODES.awaitResolution,
            };
          }

          emitProgress(
            deps,
            state.threadId,
            "search_calendar",
            `Booking ${reqStart}`,
          );
          return {
            selectedSlot: requestedSlot,
            proposal: null,
            _nextNode: NODES.createEvent,
          };
        }

        // ── Vague timeframe → free-slot scan over the search window ──────
        emitProgress(
          deps,
          state.threadId,
          "search_calendar",
          "Checking availability...",
        );
        const windowDays = state.searchWindowDays ?? 14;
        const windowStart = new Date().toISOString();
        const windowEnd = new Date(
          Date.now() + windowDays * 24 * 3_600_000,
        ).toISOString();
        const events = await deps.calendarTool.listEvents(
          auth,
          windowStart,
          windowEnd,
        );
        const eventsTravel = await padTravel(
          events,
          state.location,
          deps.mapsTool,
        );
        const slots = findFreeSlots(
          eventsTravel,
          windowStart,
          windowEnd,
          durationMinutes,
          prefs,
          3,
        );

        if (slots.length === 0) {
          // Nothing fits — look at the following two weeks for the nearest
          // alternatives and let the principal choose or widen (never a dead end).
          const extendedEnd = new Date(
            Date.parse(windowEnd) + 14 * 24 * 3_600_000,
          ).toISOString();
          const laterEvents = await deps.calendarTool.listEvents(
            auth,
            windowEnd,
            extendedEnd,
          );
          const laterTravel = await padTravel(
            laterEvents,
            state.location,
            deps.mapsTool,
          );
          const alternatives = findFreeSlots(
            laterTravel,
            windowEnd,
            extendedEnd,
            durationMinutes,
            prefs,
            3,
          );
          const windowText = `the next ${windowDays === 14 ? "two weeks" : `${windowDays} days`}`;
          return {
            proposal: {
              kind: "no_slot" as const,
              reason: alternatives.length
                ? `Nothing fits in ${windowText}. The nearest openings after that are below — pick one, or tell me to widen the search.`
                : `Nothing fits in ${windowText} (or the two weeks after). Tell me to widen the search or suggest a time.`,
              options: alternatives,
              conflictEvents: [],
              requestedSlot: null,
            },
            resolutionAttempts: 0,
            _nextNode: NODES.awaitResolution,
          };
        }
        return {
          availableSlots: slots,
          proposal: null,
          _nextNode: NODES.findSlot,
        };
      } catch (err) {
        deps.logger.error({ err }, "search-calendar failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not read your calendar. Please try again later.",
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
