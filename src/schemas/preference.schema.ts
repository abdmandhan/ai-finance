import { z } from "zod";

/**
 * Second-stage extraction for the save-preference node: flat nullable fields
 * the node normalizes into one stored preference value. The LLM only extracts;
 * code decides what to persist.
 */
export const preferenceExtractionSchema = z.object({
  kind: z
    .enum([
      "working_hours",
      "working_days",
      "no_meeting_days",
      "buffer_minutes",
      "lunch",
      "focus_blocks",
      "timezone",
      "post_arrival_buffer_minutes",
    ])
    .nullable()
    .describe(
      "Which preference the user is setting. working_hours = daily start/end; working_days = which " +
        "weekdays they work; no_meeting_days = weekdays kept meeting-free; buffer_minutes = minimum " +
        "gap between meetings; lunch = daily lunch window to keep free; focus_blocks = recurring " +
        "deep-work windows; timezone = their home timezone; post_arrival_buffer_minutes = settling " +
        "time after a flight. Null when no preference can be identified.",
    ),
  startTime: z
    .string()
    .nullable()
    .describe(
      '24h "HH:MM" start of the window (working hours / lunch / focus block). ' +
        'Default lunch with no times stated to "12:00".',
    ),
  endTime: z
    .string()
    .nullable()
    .describe(
      '24h "HH:MM" end of the window. Default lunch with no times stated to "13:00".',
    ),
  days: z
    .array(
      z.enum([
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ]),
    )
    .nullable()
    .describe(
      "Weekday names the preference applies to (working_days / no_meeting_days / focus_blocks). " +
        '"Weekdays" -> monday..friday. Null when not day-scoped.',
    ),
  bufferMinutes: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Minutes, for buffer_minutes / post_arrival_buffer_minutes"),
  timezone: z
    .string()
    .nullable()
    .describe(
      'IANA timezone for the timezone kind (e.g. "Singapore time" -> "Asia/Singapore", ' +
        '"AEST" -> "Australia/Sydney")',
    ),
  label: z
    .string()
    .nullable()
    .describe('Short label for a focus block (e.g. "deep work")'),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe(
      "If the preference cannot be pinned down, the single question to ask",
    ),
});
export type PreferenceExtraction = z.infer<typeof preferenceExtractionSchema>;

/**
 * Second-stage extraction for the save-contact node — works on direct requests
 * ("save Sarah Lim sarah@acme.com") and pasted signatures/messages alike.
 */
export const contactExtractionSchema = z.object({
  name: z.string().nullable().describe("The person's full name, if present"),
  email: z
    .string()
    .nullable()
    .describe("Their email address, exactly as written; never guess"),
  company: z
    .string()
    .nullable()
    .describe("Their organisation, if stated or inferable from the email domain/signature"),
  timezone: z
    .string()
    .nullable()
    .describe("Their IANA timezone if stated or implied by a city"),
  isEmailUpdate: z
    .boolean()
    .describe(
      'True when the user is CHANGING an existing contact\'s email (e.g. "Sarah\'s email is now ..."), ' +
        "false for saving a new contact",
    ),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe("If name or email is missing, the single question to ask"),
});
export type ContactExtraction = z.infer<typeof contactExtractionSchema>;

export const preferenceSchemas = {
  preferenceExtractionSchema,
  contactExtractionSchema,
};
