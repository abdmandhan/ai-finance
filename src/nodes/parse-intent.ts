import type { ScheduleStateType } from '@/graphs/schedule.state';
import { schedulePrompts } from '@/prompts';
import { scheduleIntentSchema } from '@/schemas';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  DEFAULT_DURATION_MINUTES,
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  NODES,
  type ScheduleDeps,
} from './shared';

/**
 * Extract scheduling entities from the user message. The LLM only extracts and
 * flags missing info; this node decides routing (clarify vs. search vs. fail).
 */
export function makeParseIntentNode(deps: ScheduleDeps) {
  return {
    name: NODES.parseIntent,
    node: async (state: ScheduleStateType) => {
      emitProgress(deps, state.threadId, 'parse_intent', 'Understanding your request...');

      const messages = [
        new SystemMessage(schedulePrompts.parseIntentPrompt()),
        new HumanMessage(state.userMessage),
      ];
      const extracted = await deps.llmService.extract(
        scheduleIntentSchema,
        messages,
        'schedule_intent',
      );

      deps.logger.info({ extracted }, 'parse-intent result');

      // Not a scheduling request — end with a failure result.
      if (extracted.intent === 'unsupported') {
        return {
          intent: extracted.intent,
          result: {
            status: 'failed' as const,
            summary: 'This does not look like a meeting-scheduling request.',
          },
          _nextNode: NODES.finalize,
        };
      }

      const durationMinutes = extracted.durationMinutes ?? DEFAULT_DURATION_MINUTES;
      const missing = !extracted.attendee || !extracted.timeframe;

      // Ask for missing info, but only up to MAX_CLARIFY_ATTEMPTS to avoid loops.
      if (missing && extracted.clarificationQuestion && state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
        return {
          intent: extracted.intent,
          attendee: extracted.attendee,
          durationMinutes,
          timezone: extracted.timezone,
          timeframe: extracted.timeframe,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: NODES.askClarification,
        };
      }

      // Still missing required info after retries — give up cleanly.
      if (missing) {
        return {
          intent: extracted.intent,
          result: {
            status: 'failed' as const,
            summary: 'Not enough information to schedule the meeting.',
          },
          _nextNode: NODES.finalize,
        };
      }

      return {
        intent: extracted.intent,
        attendee: extracted.attendee,
        durationMinutes,
        timezone: extracted.timezone,
        timeframe: extracted.timeframe,
        clarificationQuestion: null,
        _nextNode: NODES.searchCalendar,
      };
    },
  };
}
