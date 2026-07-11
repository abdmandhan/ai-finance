import { z } from "zod";

/**
 * Zod mirror of the workflow-runner's `WorkflowOutcome`, stored in assistant
 * state so the handler can build the exact outbound Kafka `output` from it.
 * A fourth kind, `agent_disabled`, marks a gated tool call.
 */

export const workflowNameSchema = z.enum(["schedule", "invoice"]);

export const workflowOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("clarification"),
    workflow: workflowNameSchema,
    question: z.string(),
  }),
  z.object({
    kind: z.literal("approval"),
    workflow: workflowNameSchema,
    message: z.string(),
    approval: z.object({
      name: z.string(),
      provider: z.string(),
      items: z.array(z.object({ ref: z.string(), label: z.string().optional() })),
    }),
  }),
  z.object({
    kind: z.literal("result"),
    workflow: workflowNameSchema,
    result: z.object({
      status: z.string(),
      summary: z.string(),
      eventId: z.string().optional(),
      htmlLink: z.string().optional(),
      invoiceId: z.string().optional(),
      suggestedSlots: z
        .array(z.object({ start: z.string(), end: z.string() }))
        .optional(),
    }),
  }),
  z.object({
    kind: z.literal("agent_disabled"),
    workflow: workflowNameSchema,
  }),
]);
export type AssistantWorkflowOutcome = z.infer<typeof workflowOutcomeSchema>;

export const assistantSchemas = {
  workflowNameSchema,
  workflowOutcomeSchema,
};
