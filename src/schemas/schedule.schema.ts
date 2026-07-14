import { z } from "zod";
import { completedApprovalSchema } from "./completed-approval.schema";

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
    .enum([
      "schedule_meeting",
      "lookup_schedule",
      "save_contact",
      "set_preference",
      "list_preferences",
      "unsupported",
    ])
    .describe(
      "schedule_meeting = book a meeting; lookup_schedule = a question about existing/upcoming " +
        "meetings or availability; save_contact = save/update a person's contact details; " +
        "set_preference = a standing scheduling preference or correction to remember; " +
        "list_preferences = asking what preferences are saved; unsupported = none of these",
    ),
  attendee: z.string().nullable().describe("Who to meet with, e.g. a name"),
  attendeeEmail: z
    .string()
    .nullable()
    .describe(
      "The attendee's email address if explicitly stated in the message; never guess it",
    ),
  additionalAttendeeEmails: z
    .array(z.string())
    .nullable()
    .describe(
      "Extra attendee email addresses explicitly present in the message (beyond the primary attendee)",
    ),
  attendeeTimezone: z
    .string()
    .nullable()
    .describe(
      'IANA timezone of the OTHER party if stated or implied by their city (e.g. "she\'s in Sydney" ' +
        '-> "Australia/Sydney"). Null when unknown.',
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
  meetingType: z
    .enum(["video", "in_person"])
    .nullable()
    .describe(
      'How the meeting happens: "video" for calls/Zoom/Meet, "in_person" when a physical venue is ' +
        "stated or implied. Null when unclear.",
    ),
  videoLink: z
    .string()
    .nullable()
    .describe(
      "An explicit video-call URL present in the message (Zoom/Meet/Teams). Never fabricate one.",
    ),
  notes: z
    .string()
    .nullable()
    .describe(
      "Context worth carrying into the calendar event description (topic, agenda, background). " +
        "Null when the message has none.",
    ),
  oneOffOverride: z
    .boolean()
    .nullable()
    .describe(
      'True ONLY when the user asks to bypass their standing preferences for this single request ' +
        '(e.g. "just this once, 7pm is fine", "ignore lunch today only"). This never changes saved preferences.',
    ),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe(
      "If required info is missing, the single question to ask the user",
    ),
  rangeStartIso: z
    .string()
    .nullable()
    .describe(
      "For lookup_schedule only: start of the calendar window the user asks about, as ISO 8601, " +
        "resolved relative to the provided current date/time (e.g. 'tomorrow' -> tomorrow 00:00 " +
        "local). Null for other intents or when no timeframe is stated.",
    ),
  rangeEndIso: z
    .string()
    .nullable()
    .describe(
      "For lookup_schedule only: end of that window as ISO 8601 (e.g. 'tomorrow' -> the day " +
        "after 00:00 local; 'this week' -> end of the week). Null when rangeStartIso is null.",
    ),
});
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;

/**
 * The principal's reply to a conflict/violation proposal, parsed by the
 * await-resolution node. Code executes the chosen action — never the LLM.
 */
export const resolutionSchema = z.object({
  action: z
    .enum([
      "pick_option",
      "accept_anyway",
      "shorten",
      "reschedule_existing",
      "new_time",
      "widen",
      "cancel",
      "unclear",
    ])
    .describe(
      "pick_option = chose one of the numbered alternatives; accept_anyway = keep the originally " +
        "requested time despite the warning; shorten = keep the time but reduce the duration; " +
        "reschedule_existing = move one of the EXISTING conflicting events instead; new_time = " +
        "proposed a different specific time; widen = search further out; cancel = drop the request; " +
        "unclear = none of these can be determined",
    ),
  optionIndex: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("1-based index of the chosen numbered option, for pick_option"),
  newDurationMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("New meeting length in minutes, for shorten"),
  newStartIso: z
    .string()
    .nullable()
    .describe(
      "Concrete ISO 8601 start for new_time, resolved relative to the provided current date/time",
    ),
  targetEventSummary: z
    .string()
    .nullable()
    .describe(
      "Which existing event to move, for reschedule_existing — match against the listed conflicts",
    ),
});
export type Resolution = z.infer<typeof resolutionSchema>;

/**
 * Final result of the schedule workflow.
 */
export const scheduleResultSchema = z.object({
  // 'proposed' = not booked; suggestedSlots offered because of a conflict / insufficient travel.
  // 'answered' = informational reply (schedule lookup); nothing was created.
  status: z.enum(["created", "cancelled", "failed", "proposed", "answered"]),
  eventId: z.string().optional(),
  htmlLink: z.string().optional(),
  suggestedSlots: z.array(slotSchema).optional(),
  summary: z.string(),
  completedApproval: completedApprovalSchema.optional(),
});
export type ScheduleResult = z.infer<typeof scheduleResultSchema>;

export const scheduleSchemas = {
  slotSchema,
  scheduleIntentSchema,
  resolutionSchema,
  scheduleResultSchema,
};
