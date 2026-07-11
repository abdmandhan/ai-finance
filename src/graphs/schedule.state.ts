import { scheduleResultSchema, slotSchema } from "@/schemas";
import { StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the schedule-meeting graph. Every field is serializable so the
 * checkpointer can persist it across the clarification / approval interrupts.
 * `_nextNode` is an ephemeral routing signal (not meant to be read after a
 * transition) and is kept untracked.
 */
/** Pending conflict/violation proposal held open while the principal picks a resolution. */
export const proposalSchema = z.object({
  kind: z.enum(["conflict", "travel", "preference", "no_slot"]),
  reason: z.string(),
  options: z.array(slotSchema),
  conflictEvents: z
    .array(
      z.object({
        eventId: z.string(),
        summary: z.string(),
        start: z.string(),
        end: z.string(),
        location: z.string().nullish(),
      }),
    )
    .default([]),
  requestedSlot: slotSchema.nullish(),
});

export const ScheduleState = new StateSchema({
  // Inputs
  threadId: z.string(),
  tenantId: z.string().default(""),
  /** Principal identity (inbound createdBy) — keys per-user preferences. */
  userId: z.string().default(""),
  userMessage: z.string(),

  // Extracted entities (see parse-intent node)
  intent: z
    .enum([
      "schedule_meeting",
      "lookup_schedule",
      "save_contact",
      "set_preference",
      "list_preferences",
      "unsupported",
    ])
    .optional(),
  attendee: z.string().nullish(),
  attendeeEmail: z.string().nullish(),
  additionalAttendeeEmails: z.array(z.string()).nullish(),
  attendeeTimezone: z.string().nullish(),
  durationMinutes: z.number().nullish(),
  timezone: z.string().nullish(),
  timeframe: z.string().nullish(),
  requestedStartIso: z.string().nullish(),
  location: z.string().nullish(),
  meetingType: z.enum(["video", "in_person"]).nullish(),
  videoLink: z.string().nullish(),
  notes: z.string().nullish(),
  oneOffOverride: z.boolean().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),
  // Lookup window (lookup_schedule intent only)
  rangeStartIso: z.string().nullish(),
  rangeEndIso: z.string().nullish(),

  // Working values
  availableSlots: z.array(slotSchema).optional(),
  selectedSlot: slotSchema.optional(),
  suggestedSlots: z.array(slotSchema).optional(),
  contactSaved: z.boolean().optional(),
  /** Ambiguous-name candidates awaiting the principal's pick (resolve-contact). */
  contactCandidates: z
    .array(
      z.object({
        name: z.string(),
        email: z.string(),
        company: z.string().nullish(),
        timezone: z.string().nullish(),
      }),
    )
    .nullish(),
  /** Saved-preferences snapshot fetched once per run (parse-intent). */
  userPrefs: z.record(z.string(), z.unknown()).nullish(),
  proposal: proposalSchema.nullish(),
  resolutionAttempts: z.number().default(0),
  /** Free-slot scan window; widened when the principal asks to look further out. */
  searchWindowDays: z.number().default(14),

  // Output
  result: scheduleResultSchema.optional(),

  // Ephemeral routing signal set by nodes, consumed by conditional edges.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type ScheduleStateType = typeof ScheduleState.State;
