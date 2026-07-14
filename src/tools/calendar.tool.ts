/**
 * Google Calendar tool — a focused port of Agent's
 * `extensions/scheduling/src/calendar-client.ts` (Google provider only).
 * Exposes list + create; the slot/conflict/travel logic lives in the search-calendar node
 * (`commons/scheduling.ts`). Tools take a CalendarAuth so the caller controls per-tenant auth.
 */
import type { ILogger } from "@/commons";
import type { CalendarAuth } from "@/services/google-auth";
import type { IProcessLogService } from "@/services/process-log.service";

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
  /** Event description — context notes and/or an explicit video link. */
  description?: string;
  /** Ask Google to attach a Meet conference to the event. */
  createMeetLink?: boolean;
}

export interface ICalendarTool {
  listEvents(
    auth: CalendarAuth,
    timeMinIso: string,
    timeMaxIso: string,
  ): Promise<CalendarEvent[]>;
  createEvent(
    auth: CalendarAuth,
    input: CreateEventInput,
  ): Promise<{ eventId: string; htmlLink?: string; meetLink?: string }>;
  /** Patch an existing event (used to reschedule a conflicting meeting). */
  updateEvent(
    auth: CalendarAuth,
    eventId: string,
    patch: Partial<CreateEventInput>,
  ): Promise<void>;
}

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

async function gcalRequest<T = unknown>(
  auth: CalendarAuth,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  processLog?: IProcessLogService,
): Promise<T> {
  const started = Date.now();
  const tool = `calendar.${method} ${path.split("?")[0]}`;
  processLog?.log({
    event: "tool.call",
    stage: "calendar.start",
    tool,
    payload: { method, path, body },
  });
  try {
    const res = await fetch(`${GCAL_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `gcal ${method} ${path} ${res.status}: ${text.slice(0, 500)}`,
      );
    const parsed = (text ? JSON.parse(text) : {}) as T;
    processLog?.log({
      event: "tool.call",
      stage: "calendar.end",
      tool,
      status: "ok",
      durationMs: Date.now() - started,
      payload: { method, path, statusCode: res.status, response: parsed },
    });
    return parsed;
  } catch (error) {
    processLog?.log({
      event: "tool.call",
      stage: "calendar.error",
      tool,
      status: "error",
      durationMs: Date.now() - started,
      payload: { method, path, body },
      error,
    });
    throw error;
  }
}

/** Real Google Calendar. */
export class GoogleCalendarTool implements ICalendarTool {
  constructor(
    private readonly logger: ILogger,
    private readonly processLog?: IProcessLogService,
  ) {}

  async listEvents(
    auth: CalendarAuth,
    timeMinIso: string,
    timeMaxIso: string,
  ): Promise<CalendarEvent[]> {
    const qs = new URLSearchParams({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    const data = await gcalRequest<{
      items?: {
        id?: string;
        summary?: string;
        location?: string;
        start?: { dateTime?: string; date?: string };
        end?: { dateTime?: string; date?: string };
      }[];
    }>(
      auth,
      "GET",
      `/calendars/${encodeURIComponent(auth.calendarId)}/events?${qs}`,
      undefined,
      this.processLog,
    );

    return (data.items ?? [])
      .map((e) => ({
        eventId: e.id ?? "",
        summary: e.summary ?? "(no title)",
        start: e.start?.dateTime ?? e.start?.date ?? "",
        end: e.end?.dateTime ?? e.end?.date ?? "",
        location: e.location,
      }))
      .filter((e) => e.start && e.end);
  }

  async createEvent(
    auth: CalendarAuth,
    input: CreateEventInput,
  ): Promise<{ eventId: string; htmlLink?: string; meetLink?: string }> {
    const body: Record<string, unknown> = {
      summary: input.summary,
      start: {
        dateTime: input.start,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      },
      end: {
        dateTime: input.end,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      },
      ...(input.location ? { location: input.location } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.attendees?.length
        ? {
            attendees: input.attendees.map((a) => ({
              email: a.email,
              displayName: a.name,
            })),
          }
        : {}),
      ...(input.createMeetLink
        ? {
            conferenceData: {
              createRequest: {
                requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : {}),
    };
    const query = input.createMeetLink ? "?conferenceDataVersion=1" : "";
    const created = await gcalRequest<{
      id?: string;
      htmlLink?: string;
      hangoutLink?: string;
    }>(
      auth,
      "POST",
      `/calendars/${encodeURIComponent(auth.calendarId)}/events${query}`,
      body,
      this.processLog,
    );
    this.logger.info({ eventId: created.id }, "calendar.createEvent");
    return {
      eventId: created.id ?? "",
      htmlLink: created.htmlLink,
      meetLink: created.hangoutLink,
    };
  }

  async updateEvent(
    auth: CalendarAuth,
    eventId: string,
    patch: Partial<CreateEventInput>,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      ...(patch.summary ? { summary: patch.summary } : {}),
      ...(patch.start
        ? {
            start: {
              dateTime: patch.start,
              ...(patch.timeZone ? { timeZone: patch.timeZone } : {}),
            },
          }
        : {}),
      ...(patch.end
        ? {
            end: {
              dateTime: patch.end,
              ...(patch.timeZone ? { timeZone: patch.timeZone } : {}),
            },
          }
        : {}),
      ...(patch.location ? { location: patch.location } : {}),
      ...(patch.description ? { description: patch.description } : {}),
    };
    await gcalRequest(
      auth,
      "PATCH",
      `/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(eventId)}`,
      body,
      this.processLog,
    );
    this.logger.info({ eventId }, "calendar.updateEvent");
  }
}

/** Offline stub for Studio / tests — a fixed busy list + a fake event id. */
export class StubCalendarTool implements ICalendarTool {
  /** Inputs of every createEvent call, for test assertions. */
  readonly created: CreateEventInput[] = [];
  /** Every updateEvent call, for test assertions. */
  readonly updates: { eventId: string; patch: Partial<CreateEventInput> }[] =
    [];

  constructor(
    private readonly logger: ILogger,
    private readonly events: CalendarEvent[] = [],
  ) {}

  async listEvents(
    _auth: CalendarAuth,
    timeMinIso: string,
    timeMaxIso: string,
  ): Promise<CalendarEvent[]> {
    const min = Date.parse(timeMinIso);
    const max = Date.parse(timeMaxIso);
    return this.events.filter(
      (e) => Date.parse(e.end) > min && Date.parse(e.start) < max,
    );
  }

  async createEvent(
    _auth: CalendarAuth,
    input: CreateEventInput,
  ): Promise<{ eventId: string; htmlLink?: string; meetLink?: string }> {
    this.logger.info({ input }, "calendar.createEvent (stub)");
    this.created.push(input);
    const eventId = `evt_${Buffer.from(`${input.attendees?.[0]?.email ?? "me"}:${input.start}`).toString("base64url")}`;
    return {
      eventId,
      htmlLink: `https://calendar.google.com/stub/${eventId}`,
      meetLink: input.createMeetLink
        ? `https://meet.google.com/stub-${eventId.slice(-8)}`
        : undefined,
    };
  }

  async updateEvent(
    _auth: CalendarAuth,
    eventId: string,
    patch: Partial<CreateEventInput>,
  ): Promise<void> {
    this.logger.info({ eventId, patch }, "calendar.updateEvent (stub)");
    this.updates.push({ eventId, patch });
    const ev = this.events.find((e) => e.eventId === eventId);
    if (ev) {
      if (patch.start) ev.start = patch.start;
      if (patch.end) ev.end = patch.end;
      if (patch.location) ev.location = patch.location;
      if (patch.summary) ev.summary = patch.summary;
    }
  }
}

export function createCalendarTool(
  logger: ILogger,
  processLog?: IProcessLogService,
): ICalendarTool {
  return new GoogleCalendarTool(logger, processLog);
}
