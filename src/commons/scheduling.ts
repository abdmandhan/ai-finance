import type { Slot } from "@/schemas";

/**
 * Pure scheduling math — ported from Agent's `extensions/scheduling/src/prefs.ts`
 * (`findFreeSlots`) and `tools.ts` (`detectConflicts`, `isPhysical`), minus focus blocks.
 * No I/O — the calendar/maps calls happen in the node; this only crunches intervals.
 */

export interface BusyEvent {
  start: string;
  end: string;
  /** Trailing travel time to the NEW meeting's location; widens this event's busy tail. */
  travelTimeAfterMs?: number;
}

export interface SchedulingPrefs {
  bufferMinutes: number;
  workingHoursStart: number; // local hour, e.g. 9
  workingHoursEnd: number; // local hour, e.g. 18
  timezone: string; // IANA, used to read the local hour of a candidate
}

/** A physical address (usable as a Maps origin/destination) vs a video link or empty. */
export function isPhysical(loc: unknown): loc is string {
  return (
    typeof loc === "string" &&
    loc.trim().length > 0 &&
    !loc.trim().startsWith("http")
  );
}

/** Existing events that overlap [startIso, endIso) — half-open overlap test. */
export function detectConflicts<T extends { start: string; end: string }>(
  existing: T[],
  startIso: string,
  endIso: string,
): T[] {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  return existing.filter((e) => {
    const eStart = Date.parse(e.start);
    const eEnd = Date.parse(e.end);
    return startMs < eEnd && endMs > eStart;
  });
}

/** Local hour-of-day (0-23) for an instant in the given IANA timezone. */
function localHour(ms: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return h === 24 ? 0 : h;
}

/** Slot fully inside working hours (start hour >= open, end hour <= close, same-day). */
function inWorkingHours(
  startMs: number,
  endMs: number,
  prefs: SchedulingPrefs,
): boolean {
  const startHour = localHour(startMs, prefs.timezone);
  // Use the end minus 1ms so an event ending exactly at close counts as inside.
  const endHour = localHour(endMs - 1, prefs.timezone);
  return (
    startHour >= prefs.workingHoursStart &&
    endHour < prefs.workingHoursEnd &&
    endMs - startMs <= 24 * 60 * 60_000
  );
}

/**
 * Free slots of `durationMinutes` within [windowStart, windowEnd), skipping busy intervals
 * padded by buffer (start) and max(travel, buffer) (end), and restricted to working hours.
 */
export function findFreeSlots(
  existingEvents: BusyEvent[],
  windowStartIso: string,
  windowEndIso: string,
  durationMinutes: number,
  prefs: SchedulingPrefs,
  count = 3,
): Slot[] {
  const bufferMs = prefs.bufferMinutes * 60_000;
  const durationMs = durationMinutes * 60_000;
  const stepMs = 15 * 60_000;
  const windowStartMs = Date.parse(windowStartIso);
  const windowEndMs = Date.parse(windowEndIso);

  const busy = existingEvents
    .map((e) => ({
      start: Date.parse(e.start) - bufferMs,
      end: Date.parse(e.end) + Math.max(e.travelTimeAfterMs ?? 0, bufferMs),
    }))
    .sort((a, b) => a.start - b.start);

  const slots: Slot[] = [];

  const probeRange = (from: number, to: number): void => {
    let probe = from;
    while (probe + durationMs <= to && slots.length < count) {
      const end = probe + durationMs;
      if (inWorkingHours(probe, end, prefs)) {
        slots.push({
          start: new Date(probe).toISOString(),
          end: new Date(end).toISOString(),
        });
        probe = end + bufferMs;
      } else {
        probe += stepMs;
      }
    }
  };

  let cursor = windowStartMs;
  for (const interval of busy) {
    probeRange(cursor, Math.min(interval.start, windowEndMs));
    cursor = Math.max(cursor, interval.end);
    if (slots.length >= count) return slots;
  }
  probeRange(cursor, windowEndMs);
  return slots;
}

/** An event as rendered by formatSchedule (calendar-tool shape, location optional). */
export interface ScheduleEntry {
  summary: string;
  start: string;
  end: string;
  location?: string;
}

const MAX_SCHEDULE_LINES = 20;

/** "Mon, Jul 13" in the given timezone. */
function formatDay(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

/** "10:00" (24h) in the given timezone. */
function formatTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

/**
 * Render a schedule-lookup answer: one line per event in the window, in the user's
 * timezone, optionally filtered by attendee (case-insensitive match on the event
 * summary — the calendar tool does not expose attendee lists). Pure — unit-testable.
 */
export function formatSchedule(
  events: ScheduleEntry[],
  windowStartIso: string,
  windowEndIso: string,
  timezone: string,
  attendee?: string | null,
): string {
  const needle = attendee?.trim().toLowerCase();
  const matched = (
    needle
      ? events.filter((e) => e.summary.toLowerCase().includes(needle))
      : events
  )
    .slice()
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const windowText = `${formatDay(Date.parse(windowStartIso), timezone)} to ${formatDay(
    Date.parse(windowEndIso) - 1,
    timezone,
  )}`;
  const who = needle ? ` with ${attendee!.trim()}` : "";

  if (matched.length === 0) {
    return `You have no meetings${who} between ${windowText}.`;
  }

  const lines = matched.slice(0, MAX_SCHEDULE_LINES).map((e) => {
    const startMs = Date.parse(e.start);
    const endMs = Date.parse(e.end);
    const when = `${formatDay(startMs, timezone)} ${formatTime(startMs, timezone)}–${formatTime(endMs, timezone)}`;
    const where = isPhysical(e.location) ? ` (@ ${e.location})` : "";
    return `- ${when} — ${e.summary}${where}`;
  });
  const overflow =
    matched.length > MAX_SCHEDULE_LINES
      ? [`...and ${matched.length - MAX_SCHEDULE_LINES} more`]
      : [];

  const count =
    matched.length === 1 ? "1 meeting" : `${matched.length} meetings`;
  return [
    `You have ${count}${who} between ${windowText}:`,
    ...lines,
    ...overflow,
  ].join("\n");
}
