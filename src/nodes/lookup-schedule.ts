import type { ScheduleStateType } from "@/graphs/schedule.state";
import { formatSchedule } from "@/commons";
import { emitProgress, NODES, type ScheduleDeps } from "./shared";

/** Default lookup window when the message states no timeframe: now → +7 days. */
const DEFAULT_LOOKUP_DAYS = 7;

/**
 * Answer a schedule-lookup question ("what is my schedule for tomorrow?").
 * Lists calendar events over the asked (or default) window and formats them
 * into an informational `answered` result. Read-only — nothing is created.
 */
export function makeLookupScheduleNode(deps: ScheduleDeps) {
  return {
    name: NODES.lookupSchedule,
    node: async (state: ScheduleStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "lookup_schedule",
        "Checking your calendar...",
      );

      const timezone = state.timezone ?? deps.defaultTimezone;
      const startMs = state.rangeStartIso
        ? Date.parse(state.rangeStartIso)
        : Date.now();
      const endMs = state.rangeEndIso
        ? Date.parse(state.rangeEndIso)
        : startMs + DEFAULT_LOOKUP_DAYS * 24 * 3_600_000;

      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        return {
          result: {
            status: "failed" as const,
            summary: "Could not understand the requested date range.",
          },
          _nextNode: NODES.finalize,
        };
      }

      try {
        const auth = await deps.resolveAuth(state.tenantId);
        const events = await deps.calendarTool.listEvents(
          auth,
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
        );
        const summary = formatSchedule(
          events,
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
          timezone,
          state.attendee,
        );
        return {
          result: { status: "answered" as const, summary },
          _nextNode: NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "lookup-schedule failed");
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
