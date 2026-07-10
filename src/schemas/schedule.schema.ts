import { z } from 'zod';

/**
 * A concrete calendar availability window returned by the calendar tool.
 */
export const slotSchema = z.object({
  start: z.string().describe('ISO 8601 start time'),
  end: z.string().describe('ISO 8601 end time'),
});
export type Slot = z.infer<typeof slotSchema>;

/**
 * Entities extracted from the user's scheduling request by the parse-intent node.
 * Fields are optional so the graph can detect what is still missing and ask.
 */
export const scheduleIntentSchema = z.object({
  intent: z
    .enum(['schedule_meeting', 'unsupported'])
    .describe('Whether this request is a meeting-scheduling request we can handle'),
  attendee: z.string().nullable().describe('Who to meet with, e.g. a name or email'),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('Meeting length in minutes, if stated'),
  timezone: z.string().nullable().describe('IANA timezone, e.g. "Asia/Jakarta", if stated'),
  timeframe: z
    .string()
    .nullable()
    .describe('Natural-language timeframe, e.g. "next week", "tomorrow afternoon"'),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe('If required info is missing, the single question to ask the user'),
});
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;

/**
 * Final result of the schedule workflow.
 */
export const scheduleResultSchema = z.object({
  status: z.enum(['created', 'cancelled', 'failed']),
  eventId: z.string().optional(),
  summary: z.string(),
});
export type ScheduleResult = z.infer<typeof scheduleResultSchema>;

export const scheduleSchemas = {
  slotSchema,
  scheduleIntentSchema,
  scheduleResultSchema,
};
