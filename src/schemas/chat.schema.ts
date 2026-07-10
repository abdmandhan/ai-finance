import { z } from 'zod';

/**
 * Zod mirrors of the real Kafka contract (the entire App<->Agent seam). Source of
 * truth: Go structs in `App/apps/backend/internal/models/schemas/chat.go`, Agent TS
 * `Agent/extensions/kafka/src/types.ts`, docs `App/docs/kafka-topics.md`.
 * Kafka message key = `chatId` on all three topics; `chatId` is the LangGraph thread_id.
 */

// ── Shared content ───────────────────────────────────────────────────

export const chatContentSchema = z.object({
  type: z.enum(['text', 'photo', 'document']),
  text: z.string().optional(),
  fileId: z.string().optional(),
  url: z.string().optional(),
  mimeType: z.string().optional(),
  fileName: z.string().optional(),
  size: z.number().optional(),
});
export type ChatContent = z.infer<typeof chatContentSchema>;

// ── chat.inbound (App -> this service) ───────────────────────────────

/** KafkaChatInbound — a normalized user message. Only the fields we rely on are required. */
export const inboundMessageSchema = z.object({
  requestId: z.string(),
  chatId: z.string(),
  createdBy: z.string(),
  role: z.literal('human').default('human'),
  content: z.array(chatContentSchema).default(() => []),
  provider: z.string().optional(),
  messageId: z.string().optional(),
  chatType: z.string().optional(),
  tenantId: z.string().optional(),
  timestamp: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type InboundMessage = z.infer<typeof inboundMessageSchema>;

// ── chat.outbound (this service -> App) ──────────────────────────────

export const approvalItemSchema = z.object({
  ref: z.string(),
  label: z.string().optional(),
  status: z.enum(['pending', 'completed', 'failed', 'rejected']),
  detail: z.string().optional(),
});
export type ApprovalItem = z.infer<typeof approvalItemSchema>;

export const approvalDataSchema = z.object({
  name: z.string(),
  provider: z.string().optional(),
  items: z.array(approvalItemSchema).optional(),
  args: z.unknown().optional(),
});
export type ApprovalData = z.infer<typeof approvalDataSchema>;

export const outboundOutputSchema = z.object({
  answer: z.string(),
  intent: z.string().optional(),
  stage: z.string().optional(),
  agentKey: z.string().optional(),
  approvalData: z.array(approvalDataSchema).optional(),
});
export type OutboundOutput = z.infer<typeof outboundOutputSchema>;

/** KafkaChatOutbound — the AI reply. Must echo requestId/chatId/messageId/tenantId/provider. */
export const outboundMessageSchema = z.object({
  requestId: z.string(),
  chatId: z.string(),
  messageId: z.string().optional(),
  tenantId: z.string().optional(),
  provider: z.string().optional(),
  content: z.array(chatContentSchema).optional(),
  output: outboundOutputSchema.optional(),
});
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;

// ── chat.events (this service -> App) ────────────────────────────────

/** ChatProgressResponse — ephemeral progress. Thin `{stage,msg,timestamp}` plus tool fields. */
export const progressEventSchema = z.object({
  stage: z.string(),
  msg: z.string(),
  timestamp: z.string(),
  toolName: z.string().optional(),
  phase: z.string().optional(),
  itemId: z.string().optional(),
  toolCallId: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  tenantId: z.string().optional(),
  requestId: z.string().optional(),
  messageId: z.string().optional(),
});
export type ProgressEvent = z.infer<typeof progressEventSchema>;

export const chatSchemas = {
  chatContentSchema,
  inboundMessageSchema,
  outboundMessageSchema,
  outboundOutputSchema,
  approvalDataSchema,
  approvalItemSchema,
  progressEventSchema,
};
