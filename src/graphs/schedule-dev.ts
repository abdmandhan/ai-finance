/**
 * Dev-only graph entry point for the LangGraph CLI / Studio.
 * Exports a module-level compiled graph with log-only progress and NO custom
 * checkpointer — the LangGraph dev server manages persistence (and therefore the
 * interrupt pause/resume) itself.
 */
import { configUtils, loggerUtils } from '@/commons';
import { buildScheduleGraph } from '@/graphs/schedule.graph';
// Import the concrete modules (not the `@/services` barrel) so the Studio dev
// server does not pull in kafka.service.ts and load the native Kafka addon.
import { createLlmService } from '@/services/llm.service';
import { createCalendarTool } from '@/tools/calendar.tool';

const config = configUtils.initConfig();
const logger = loggerUtils.createLogger(config.log);

export const graph = buildScheduleGraph({
  llmService: createLlmService(config.llm),
  calendarTool: createCalendarTool(logger),
  logger,
  onProgress: (chatId, event) => logger.info({ chatId, event }, 'progress'),
});
