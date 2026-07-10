/**
 * Google Calendar tool — a focused port of Agent's
 * `extensions/scheduling/src/calendar-client.ts` (Google provider only).
 * Exposes list + create; the slot/conflict/travel logic lives in the search-calendar node
 * (`commons/scheduling.ts`). Tools take a CalendarAuth so the caller controls per-tenant auth.
 */
import type { ILogger } from '@/commons';
import type { CalendarAuth } from '@/services/google-auth';

export interface CalendarEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
}

export interface CreateEventInput {
  summary: string;
  start: string;
  end: string;
  timeZone?: string;
  location?: string;
  attendees?: { email: string; name?: string }[];
}

export interface ICalendarTool {
  listEvents(auth: CalendarAuth, timeMinIso: string, timeMaxIso: string): Promise<CalendarEvent[]>;
  createEvent(auth: CalendarAuth, input: CreateEventInput): Promise<{ eventId: string; htmlLink?: string }>;
}

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';

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

/** Real Google Calendar. */
export class GoogleCalendarTool implements ICalendarTool {
  constructor(private readonly logger: ILogger) {}

  async listEvents(auth: CalendarAuth, timeMinIso: string, timeMaxIso: string): Promise<CalendarEvent[]> {
    const qs = new URLSearchParams({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    const data = await gcalRequest<{
      items?: {
        id?: string;
        summary?: string;
        location?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }[];
    }>(auth, 'GET', `/calendars/${encodeURIComponent(auth.calendarId)}/events?${qs}`);

    return (data.items ?? [])
      .map((e) => ({
        eventId: e.id ?? '',
        summary: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date ?? '',
        end: e.end?.dateTime ?? e.end?.date ?? '',
        location: e.location,
      }))
      .filter((e) => e.start && e.end);
  }

  async createEvent(
    auth: CalendarAuth,
    input: CreateEventInput,
  ): Promise<{ eventId: string; htmlLink?: string }> {
    const body: Record<string, unknown> = {
      summary: input.summary,
      start: { dateTime: input.start, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      end: { dateTime: input.end, ...(input.timeZone ? { timeZone: input.timeZone } : {}) },
      ...(input.location ? { location: input.location } : {}),
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

/** Offline stub for Studio / tests — a fixed busy list + a fake event id. */
export class StubCalendarTool implements ICalendarTool {
  constructor(
    private readonly logger: ILogger,
    private readonly events: CalendarEvent[] = [],
  ) {}

  async listEvents(_auth: CalendarAuth, timeMinIso: string, timeMaxIso: string): Promise<CalendarEvent[]> {
    const min = Date.parse(timeMinIso);
    const max = Date.parse(timeMaxIso);
    return this.events.filter((e) => Date.parse(e.end) > min && Date.parse(e.start) < max);
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
