import { scheduleResultSchema, slotSchema } from "@/schemas";
import { StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the schedule-meeting graph. Every field is serializable so the
 * checkpointer can persist it across the clarification / approval interrupts.
 * `_nextNode` is an ephemeral routing signal (not meant to be read after a
 * transition) and is kept untracked.
 */
export const ScheduleState = new StateSchema({
  // Inputs
  threadId: z.string(),
  tenantId: z.string().default(""),
  userMessage: z.string(),

  // Extracted entities (see parse-intent node)
  intent: z.enum(["schedule_meeting", "unsupported"]).optional(),
  attendee: z.string().nullish(),
  attendeeEmail: z.string().nullish(),
  durationMinutes: z.number().nullish(),
  timezone: z.string().nullish(),
  timeframe: z.string().nullish(),
  requestedStartIso: z.string().nullish(),
  location: z.string().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),

  // Working values
  availableSlots: z.array(slotSchema).optional(),
  selectedSlot: slotSchema.optional(),
  suggestedSlots: z.array(slotSchema).optional(),
  contactSaved: z.boolean().optional(),

  // Output
  result: scheduleResultSchema.optional(),

  // Ephemeral routing signal set by nodes, consumed by conditional edges.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type ScheduleStateType = typeof ScheduleState.State;
