import { z } from "zod";

/**
 * A concrete calendar availability window returned by the calendar tool.
 */
export const slotSchema = z.object({
  start: z.string().describe("ISO 8601 start time"),
  end: z.string().describe("ISO 8601 end time"),
});
export type Slot = z.infer<typeof slotSchema>;

/**
 * Entities extracted from the user's scheduling request by the parse-intent node.
 * Fields are optional so the graph can detect what is still missing and ask.
 */
export const scheduleIntentSchema = z.object({
  intent: z
    .enum(["schedule_meeting", "unsupported"])
    .describe(
      "Whether this request is a meeting-scheduling request we can handle",
    ),
  attendee: z.string().nullable().describe("Who to meet with, e.g. a name"),
  attendeeEmail: z
    .string()
    .nullable()
    .describe(
      "The attendee's email address if explicitly stated in the message; never guess it",
    ),
  durationMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Meeting length in minutes, if stated"),
  timezone: z
    .string()
    .nullable()
    .describe('IANA timezone, e.g. "Asia/Jakarta", if stated'),
  timeframe: z
    .string()
    .nullable()
    .describe(
      'Natural-language timeframe, e.g. "next week", "tomorrow afternoon"',
    ),
  requestedStartIso: z
    .string()
    .nullable()
    .describe(
      "The concrete meeting start as ISO 8601, resolved from the message relative to the " +
        "provided current date/time. Null if no specific day+time was requested.",
    ),
  location: z
    .string()
    .nullable()
    .describe(
      "Physical meeting address/venue if stated (used for travel time). Video links are NOT a location.",
    ),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe(
      "If required info is missing, the single question to ask the user",
    ),
});
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;

/**
 * Final result of the schedule workflow.
 */
export const scheduleResultSchema = z.object({
  // 'proposed' = not booked; suggestedSlots offered because of a conflict / insufficient travel.
  status: z.enum(["created", "cancelled", "failed", "proposed"]),
  eventId: z.string().optional(),
  htmlLink: z.string().optional(),
  suggestedSlots: z.array(slotSchema).optional(),
  summary: z.string(),
});
export type ScheduleResult = z.infer<typeof scheduleResultSchema>;

export const scheduleSchemas = {
  slotSchema,
  scheduleIntentSchema,
  scheduleResultSchema,
};
