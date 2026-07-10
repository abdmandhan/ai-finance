/**
 * Dev-only graph entry point for the LangGraph CLI / Studio.
 * Uses offline STUB tools + a fake auth so Studio runs without Google creds or Kafka.
 * No custom checkpointer — the dev server manages persistence (and interrupt resume).
 */
import { configUtils, loggerUtils } from '@/commons';
import { buildScheduleGraph } from '@/graphs/schedule.graph';
// Import concrete modules (not the `@/services` barrel) so Studio does not pull in
// kafka.service.ts and load the native Kafka addon.
import { createLlmService } from '@/services/llm.service';
import type { CalendarAuth } from '@/services/google-auth';
import { StubCalendarTool } from '@/tools/calendar.tool';
import { StubContactsTool } from '@/tools/contacts.tool';

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

const fakeAuth: CalendarAuth = {
  accessToken: 'stub',
  provider: 'google',
  calendarId: 'primary',
  emailAddress: 'dev@example.com',
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

export const graph = buildScheduleGraph({
  llmService: createLlmService(config.llm),
  calendarTool: new StubCalendarTool(logger),
  // Seed one known contact so the happy path runs without a clarification.
  contactsTool: new StubContactsTool([{ name: 'Sarah', email: 'sarah@example.com' }]),
  resolveAuth: async () => fakeAuth,
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, 'progress'),
});
