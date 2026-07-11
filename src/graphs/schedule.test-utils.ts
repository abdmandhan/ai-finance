/**
 * Shared fixtures for the schedule-graph test files: a stubbed dependency set,
 * a mocked LLM whose extract() returns queued values in order, and an intent
 * factory covering every extraction field.
 */
import { vi, type Mock } from "vitest";
import { pino } from "pino";
import { MemorySaver } from "@langchain/langgraph";
import type { ScheduleIntent } from "@/schemas";
import type { CalendarAuth, ILlmService } from "@/services";
import {
  InMemoryPreferencesTool,
  StubCalendarTool,
  StubContactsTool,
  StubMapsTool,
  type CalendarEvent,
  type Contact,
} from "@/tools";
import type { ScheduleDeps } from "@/nodes";
import { buildScheduleGraph } from "./schedule.graph";

export function intent(over: Partial<ScheduleIntent> = {}): ScheduleIntent {
  return {
    intent: "schedule_meeting",
    attendee: "Sarah",
    attendeeEmail: null,
    additionalAttendeeEmails: null,
    attendeeTimezone: null,
    durationMinutes: 30,
    timezone: null,
    timeframe: "next week",
    requestedStartIso: null,
    location: null,
    meetingType: null,
    videoLink: null,
    notes: null,
    oneOffOverride: null,
    clarificationQuestion: null,
    rangeStartIso: null,
    rangeEndIso: null,
    ...over,
  };
}

export const fakeAuth: CalendarAuth = {
  accessToken: "x",
  provider: "google",
  calendarId: "primary",
  emailAddress: "me@example.com",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

export function buildGraph(
  opts: {
    /** Queue of extract() results — intents, resolutions, contact/pref extractions, in call order. */
    intents?: unknown[];
    contacts?: Contact[];
    events?: CalendarEvent[];
    travelMinutes?: number;
    preferencesTool?: InMemoryPreferencesTool;
  } = {},
) {
  const logger = pino({ level: "silent" });
  const extract: Mock = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { invoke: vi.fn(), extract, chat: vi.fn() };
  const contactsTool = new StubContactsTool(opts.contacts ?? []);
  const calendarTool = new StubCalendarTool(logger, opts.events ?? []);
  const preferencesTool = opts.preferencesTool ?? new InMemoryPreferencesTool();
  const deps: ScheduleDeps = {
    llmService,
    calendarTool,
    contactsTool,
    mapsTool: new StubMapsTool(opts.travelMinutes ?? 10),
    resolveAuth: async () => fakeAuth,
    defaultTimezone: "UTC",
    schedulingPrefs: {
      bufferMinutes: 15,
      workingHoursStart: 9,
      workingHoursEnd: 18,
    },
    preferencesTool,
    logger,
  };
  return {
    graph: buildScheduleGraph(deps, new MemorySaver()),
    contactsTool,
    calendarTool,
    preferencesTool,
    extract,
  };
}
