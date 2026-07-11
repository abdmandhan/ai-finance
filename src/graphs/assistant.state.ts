import { attachmentRefSchema, workflowOutcomeSchema } from "@/schemas";
import { MessagesValue, StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the main assistant graph. `messages` is the checkpointed
 * conversation memory (thread_id `assistant:<chatId>`); everything the model
 * must never invent (chatId, tenantId, attachments, enablement) is threaded
 * through state, not tool arguments.
 */
export const AssistantState = new StateSchema({
  messages: MessagesValue,

  // Per-turn inputs (the handler passes these on every invoke)
  chatId: z.string(),
  tenantId: z.string().default(""),
  userId: z.string().default(""),
  attachments: z.array(attachmentRefSchema).default(() => []),
  enablement: z
    .object({ scheduling: z.boolean(), invoicing: z.boolean() })
    .default({ scheduling: false, invoicing: false }),

  // Resume turn: structured result of a just-finished workflow to phrase for the user.
  workflowReport: workflowOutcomeSchema.nullish(),

  // Captured by the tool-executor node; the handler reads it to build the outbound
  // `output`. Checkpointed, so the handler resets it (`outcome: null`) each invoke.
  outcome: workflowOutcomeSchema.nullish(),

  // Ephemeral routing signal set by nodes, consumed by conditional edges.
  _nextNode: new UntrackedValue(z.string().optional()),
  // Ephemeral: set after a workflow paused — the follow-up model call gets no tools.
  _relayOnly: new UntrackedValue(z.boolean().optional()),
});

export type AssistantStateType = typeof AssistantState.State;
