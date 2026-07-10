/**
 * Google Calendar tool — a focused port of Agent's
 * `extensions/scheduling/src/calendar-client.ts` (Google provider only).
 * Free-slot search is a simplified working-hours scan (not Agent's full prefs/buffer/travel
 * algorithm). Tools take a CalendarAuth so the caller controls per-tenant auth.
 */
import type { ILogger } from '@/commons';
import type { Slot } from '@/schemas';
import type { CalendarAuth } from '@/services/google-auth';

export interface CreateEventInput {
  summary: string;
  start: string;
  end: string;
  timeZone?: string;
  attendees?: { email: string; name?: string }[];
}

export interface ICalendarTool {
  searchAvailability(
    auth: CalendarAuth,
    params: { durationMinutes: number; timeframe?: string; timezone?: string },
  ): Promise<Slot[]>;
  createEvent(auth: CalendarAuth, input: CreateEventInput): Promise<{ eventId: string; htmlLink?: string }>;
}

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;
const MAX_SLOTS = 3;

async function gcalRequest<T = unknown>(
  auth: CalendarAuth,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GCAL_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gcal ${method} ${path} ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Next business day (skips Sat/Sun) at 00:00 UTC. */
function nextBusinessDayUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

/** Real Google Calendar. */
export class GoogleCalendarTool implements ICalendarTool {
  constructor(private readonly logger: ILogger) {}

  async searchAvailability(
    auth: CalendarAuth,
    params: { durationMinutes: number; timeframe?: string; timezone?: string },
  ): Promise<Slot[]> {
    const day = nextBusinessDayUtc();
    const windowStart = new Date(day);
    windowStart.setUTCHours(WORK_START_HOUR);
    const windowEnd = new Date(day);
    windowEnd.setUTCHours(WORK_END_HOUR);

    // Pull busy intervals for the window.
    const qs = new URLSearchParams({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const data = await gcalRequest<{ items?: { start?: { dateTime?: string }; end?: { dateTime?: string } }[] }>(
      auth,
      'GET',
      `/calendars/${encodeURIComponent(auth.calendarId)}/events?${qs}`,
    );
    const busy = (data.items ?? [])
      .map((e) => ({ start: e.start?.dateTime, end: e.end?.dateTime }))
      .filter((b): b is { start: string; end: string } => Boolean(b.start && b.end))
      .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));

    const durMs = params.durationMinutes * 60_000;
    const slots: Slot[] = [];
    // Candidate starts every 30 min inside working hours.
    for (let t = windowStart.getTime(); t + durMs <= windowEnd.getTime(); t += 30 * 60_000) {
      const end = t + durMs;
      const overlaps = busy.some((b) => t < b.end && end > b.start);
      if (!overlaps) {
        slots.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() });
        if (slots.length >= MAX_SLOTS) break;
      }
    }
    this.logger.info({ count: slots.length }, 'calendar.searchAvailability');
    return slots;
  }

  async createEvent(
    auth: CalendarAuth,
    input: CreateEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    const body: Record<string, unknown> = {
      summary: input.summary,
      start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      ...(input.attendees?.length
        ? { attendees: input.attendees.map((a) => ({ email: a.email, displayName: a.name })) }
        : {}),
    };
    const created = await gcalRequest<{ id?: string; htmlLink?: string }>(
      auth,
      'POST',
      `/calendars/${encodeURIComponent(auth.calendarId)}/events`,
      body,
    );
    this.logger.info({ eventId: created.id }, 'calendar.createEvent');
    return { eventId: created.id ?? '', htmlLink: created.htmlLink };
  }
}

/** Offline stub for Studio / tests — deterministic slots + fake event id. */
export class StubCalendarTool implements ICalendarTool {
  constructor(private readonly logger: ILogger) {}

  async searchAvailability(
    _auth: CalendarAuth,
    params: { durationMinutes: number; timeframe?: string; timezone?: string },
  ): Promise<Slot[]> {
    const day = nextBusinessDayUtc();
    return [9, 11, 14].map((h) => {
      const start = new Date(day);
      start.setUTCHours(h);
      const end = new Date(start.getTime() + params.durationMinutes * 60_000);
      return { start: start.toISOString(), end: end.toISOString() };
    });
  }

  async createEvent(
    _auth: CalendarAuth,
    input: CreateEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    this.logger.info({ input }, 'calendar.createEvent (stub)');
    const eventId = `evt_${Buffer.from(`${input.attendees?.[0]?.email ?? 'me'}:${input.start}`).toString('base64url')}`;
    return { eventId, htmlLink: `https://calendar.google.com/stub/${eventId}` };
  }
}

export function createCalendarTool(logger: ILogger): ICalendarTool {
  return new GoogleCalendarTool(logger);
}
