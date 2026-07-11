import { z } from "zod";

/** Top-level workflow router: which graph should handle an inbound message. */
export const workflowClassificationSchema = z.object({
  workflow: z
    .enum(["schedule", "invoice", "unsupported"])
    .describe(
      "schedule = book/reschedule a meeting, ask about the user's schedule/calendar/meetings, " +
        "save/update a contact, or state/ask about scheduling preferences (hours, lunch, buffers, " +
        "timezone); invoice = create a sales invoice or supplier bill in Xero; unsupported = neither",
    ),
});
export type WorkflowClassification = z.infer<
  typeof workflowClassificationSchema
>;
