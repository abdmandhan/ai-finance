/**
 * Prompt for the parse-intent node. The LLM only extracts entities and decides
 * whether clarification is needed — code validates and drives the workflow.
 */
function parseIntentPrompt(): string {
  return [
    'You are the intent parser for a meeting-scheduling assistant.',
    'Extract scheduling entities from the user message into the required schema.',
    '',
    'Rules:',
    '- Set `intent` to "schedule_meeting" only if the user wants to schedule/book a meeting;',
    '  otherwise "unsupported".',
    '- Fill `attendee`, `durationMinutes`, `timezone`, and `timeframe` only when clearly stated;',
    '  use null when absent. Do not invent values.',
    '- If `attendee` OR `timeframe` is missing for a schedule request, set `clarificationQuestion`',
    '  to a single, specific question asking for exactly what is missing. Otherwise set it to null.',
    '- Default `durationMinutes` to null (the graph applies a default) — do not guess a duration.',
  ].join('\n');
}

export const schedulePrompts = {
  parseIntentPrompt,
};
