import { attachmentRefSchema, workflowOutcomeSchema } from "@/schemas";
import type { BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import {
  messagesStateReducer,
  ReducedValue,
  StateSchema,
  UntrackedValue,
} from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the main assistant graph. `messages` is the checkpointed
 * conversation memory (thread_id `assistant:<chatId>`); everything the model
 * must never invent (chatId, tenantId, attachments, enablement) is threaded
 * through state, not tool arguments.
 */
export const AssistantState = new StateSchema({
  // Persistent-state bound: keep the last 25 messages. Read-time windowing
  // (assistant.max_history_messages) sits above this; the reducer cap is what
  // stops the checkpointed thread growing without bound.
  messages: new ReducedValue(
    z.custom<BaseMessage[]>().default(() => []),
    {
      inputSchema: z.custom<BaseMessageLike[]>(),
      reducer: (left, right) => messagesStateReducer(left, right).slice(-25),
    },
  ),

  // Step budget for the model↔tools loop; the handler resets it each turn
  // (negative delta), the max-steps guard in call-model ends runaway loops.
  stepCount: new ReducedValue(z.number().default(0), {
    reducer: (previous, next) => previous + next,
  }),

  // Per-turn inputs (the handler passes these on every invoke)
  chatId: z.string(),
  tenantId: z.string().default(""),
  userId: z.string().default(""),
  attachments: z.array(attachmentRefSchema).default(() => []),
  enablement: z
    .object({
      scheduling: z.boolean(),
      invoicing: z.boolean(),
      expense: z.boolean().default(false),
    })
    .default({ scheduling: false, invoicing: false, expense: false }),

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
