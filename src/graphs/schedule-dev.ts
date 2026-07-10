/**
 * Dev-only graph entry point for the LangGraph CLI / Studio.
 * Uses offline STUB tools + a fake auth so Studio runs without Google creds or Kafka.
 * No custom checkpointer — the dev server manages persistence (and interrupt resume).
 */
import { configUtils, loggerUtils } from "@/commons";
import { buildScheduleGraph } from "@/graphs/schedule.graph";
// Import concrete modules (not the `@/services` barrel) so Studio does not pull in
// kafka.service.ts and load the native Kafka addon.
import { createLlmService } from "@/services/llm.service";
import type { CalendarAuth } from "@/services/google-auth";
import { StubCalendarTool } from "@/tools/calendar.tool";
import { StubContactsTool } from "@/tools/contacts.tool";
import { StubMapsTool } from "@/tools/maps.tool";

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const fakeAuth: CalendarAuth = {
  accessToken: "stub",
  provider: "google",
  calendarId: "primary",
  emailAddress: "dev@example.com",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

export const graph = buildScheduleGraph({
  llmService: createLlmService(config.llm),
  // Seed a busy event so you can demo a conflict / travel proposal in Studio.
  calendarTool: new StubCalendarTool(logger, [
    {
      eventId: "seed-1",
      summary: "Existing meeting",
      start: "2026-07-13T10:00:00.000Z",
      end: "2026-07-13T11:00:00.000Z",
      location: "10 Downing St, London",
    },
  ]),
  // Seed one known contact so the happy path runs without a clarification.
  contactsTool: new StubContactsTool([
    { name: "Sarah", email: "sarah@example.com" },
  ]),
  mapsTool: new StubMapsTool(40),
  resolveAuth: async () => fakeAuth,
  defaultTimezone: config.calendar.default_timezone,
  schedulingPrefs: {
    bufferMinutes: config.calendar.buffer_minutes,
    workingHoursStart: config.calendar.working_hours_start,
    workingHoursEnd: config.calendar.working_hours_end,
  },
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, "progress"),
});
