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

/** Recurring daily block (lunch, deep work) in minutes since local midnight. */
export interface TimeWindow {
  startMinutes: number;
  endMinutes: number;
}

export interface FocusBlock extends TimeWindow {
  /** Weekdays (0=Sun..6=Sat) the block applies to; absent = every day. */
  days?: number[];
  label?: string;
}

export interface SchedulingPrefs {
  bufferMinutes: number;
  workingHoursStart: number; // local hour, e.g. 9
  workingHoursEnd: number; // local hour, e.g. 18
  timezone: string; // IANA, used to read the local hour of a candidate
  /** Weekdays meetings are allowed (0=Sun..6=Sat); absent = all days. */
  workingDays?: number[];
  /** Weekdays explicitly kept meeting-free (e.g. "no meetings Fridays"). */
  noMeetingDays?: number[];
  lunch?: TimeWindow;
  focusBlocks?: FocusBlock[];
}

/** Why a candidate slot is unacceptable under the principal's preferences. */
export interface SlotViolation {
  kind:
    | "working_hours"
    | "non_working_day"
    | "no_meeting_day"
    | "lunch"
    | "focus_block";
  message: string;
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

/** Minutes since local midnight (0-1439) for an instant in the given IANA timezone. */
function localMinutes(ms: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (h === 24 ? 0 : h) * 60 + m;
}

/** Local weekday (0=Sun..6=Sat) for an instant in the given IANA timezone. */
function localWeekday(ms: number, timezone: string): number {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "12:30" from minutes-since-midnight. */
function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Two [start, end) minute ranges on the same local day overlap. */
function minutesOverlap(
  aStart: number,
  aEnd: number,
  b: TimeWindow,
): boolean {
  return aStart < b.endMinutes && aEnd > b.startMinutes;
}

/**
 * First preference the slot violates, or null if acceptable. Checks day-of-week,
 * working hours (minute precision), lunch, then focus blocks — all in prefs.timezone.
 */
export function slotViolation(
  startMs: number,
  endMs: number,
  prefs: SchedulingPrefs,
): SlotViolation | null {
  if (endMs - startMs > 24 * 60 * 60_000) {
    return { kind: "working_hours", message: "That spans more than a day." };
  }
  const tz = prefs.timezone;
  const weekday = localWeekday(startMs, tz);
  if (prefs.noMeetingDays?.includes(weekday)) {
    return {
      kind: "no_meeting_day",
      message: `${WEEKDAY_NAMES[weekday]}s are kept meeting-free.`,
    };
  }
  if (prefs.workingDays && !prefs.workingDays.includes(weekday)) {
    return {
      kind: "non_working_day",
      message: `${WEEKDAY_NAMES[weekday]} is outside your working days.`,
    };
  }
  const startMin = localMinutes(startMs, tz);
  // Duration-derived end keeps the range on one local day (a midnight end reads as 24:00).
  const endMin = startMin + Math.round((endMs - startMs) / 60_000);
  const openMin = prefs.workingHoursStart * 60;
  const closeMin = prefs.workingHoursEnd * 60;
  if (startMin < openMin || endMin > closeMin) {
    return {
      kind: "working_hours",
      message: `That falls outside your working hours (${minutesToHhmm(openMin)}–${minutesToHhmm(closeMin)}).`,
    };
  }
  if (prefs.lunch && minutesOverlap(startMin, endMin, prefs.lunch)) {
    return {
      kind: "lunch",
      message: `That overlaps your lunch break (${minutesToHhmm(prefs.lunch.startMinutes)}–${minutesToHhmm(prefs.lunch.endMinutes)}).`,
    };
  }
  for (const block of prefs.focusBlocks ?? []) {
    const applies = !block.days || block.days.includes(weekday);
    if (applies && minutesOverlap(startMin, endMin, block)) {
      return {
        kind: "focus_block",
        message: `That overlaps your ${block.label ?? "focus"} block (${minutesToHhmm(block.startMinutes)}–${minutesToHhmm(block.endMinutes)}).`,
      };
    }
  }
  return null;
}

/** Slot acceptable under all preference constraints (hours, days, lunch, focus). */
function inWorkingHours(
  startMs: number,
  endMs: number,
  prefs: SchedulingPrefs,
): boolean {
  return slotViolation(startMs, endMs, prefs) === null;
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

/** "Mon, Jul 13 10:00–10:30" in the given timezone. */
function formatRange(startMs: number, endMs: number, timezone: string): string {
  return `${formatDay(startMs, timezone)} ${formatTime(startMs, timezone)}–${formatTime(endMs, timezone)}`;
}

/**
 * Render a slot in the principal's timezone, and — when the other party sits in a
 * different zone — also in theirs: "Mon, Jul 13 10:00–10:30 (Asia/Singapore) /
 * Mon, Jul 13 13:00–13:30 (Australia/Sydney)".
 */
export function formatSlotDual(
  slot: { start: string; end: string },
  principalTz: string,
  attendeeTz?: string | null,
): string {
  const startMs = Date.parse(slot.start);
  const endMs = Date.parse(slot.end);
  const principal = formatRange(startMs, endMs, principalTz);
  if (!attendeeTz || attendeeTz === principalTz) return principal;
  const attendee = formatRange(startMs, endMs, attendeeTz);
  return `${principal} (${principalTz}) / ${attendee} (${attendeeTz})`;
}

/** One-line event summary for conflict messages: when — what (@ where). */
export function formatEventLine(e: ScheduleEntry, timezone: string): string {
  const when = formatRange(Date.parse(e.start), Date.parse(e.end), timezone);
  const where = isPhysical(e.location) ? ` (@ ${e.location})` : "";
  return `${when} — ${e.summary}${where}`;
}

const FLIGHT_RE =
  /(\bflight\b|\bfly(?:ing)?\b|✈|\barriv(?:al|es|ing)?\b|\bland(?:s|ing)?\b|\bairport\b|\bterminal\b|\b[A-Z]{2}\s?\d{2,4}\b)/;

/**
 * Heuristic: does this event look like a flight / arrival leg? Matches airline-code
 * patterns ("SQ123") case-sensitively and travel keywords case-insensitively on the
 * summary or location. Used to add a post-arrival buffer before the next onsite meeting.
 */
export function isFlightLike(e: {
  summary: string;
  location?: string;
}): boolean {
  const text = `${e.summary} ${e.location ?? ""}`;
  return FLIGHT_RE.test(text) || FLIGHT_RE.test(text.toLowerCase());
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
