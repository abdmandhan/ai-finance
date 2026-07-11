import type { InboundMessage, OutboundMessage } from "@/schemas";

/** Correlation fields echoed from the inbound message onto every outbound reply. */
export interface Correlation {
  requestId: string;
  messageId?: string;
  tenantId?: string;
  provider?: string;
}

/**
 * Per-chat correlation cache + `baseOutbound` builder, shared by both handlers.
 * Kafka replies must echo requestId/messageId/tenantId/provider of the message
 * they answer.
 */
export function createCorrelationStore() {
  const correlations = new Map<string, Correlation>();

  return {
    remember(msg: InboundMessage): void {
      correlations.set(msg.chatId, {
        requestId: msg.requestId,
        messageId: msg.messageId,
        tenantId: msg.tenantId,
        provider: msg.provider,
      });
    },
    baseOutbound(chatId: string): OutboundMessage {
      const c = correlations.get(chatId);
      return {
        chatId,
        requestId: c?.requestId ?? chatId,
        messageId: c?.messageId,
        tenantId: c?.tenantId,
        provider: c?.provider,
      };
    },
  };
}
export type CorrelationStore = ReturnType<typeof createCorrelationStore>;

/** Flatten all text content parts of an inbound message into one string. */
export function inboundText(msg: InboundMessage): string {
  return msg.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

/** Extract photo/document attachments carried on an inbound message. */
export function inboundAttachments(
  msg: InboundMessage,
): { url: string; mimeType: string; fileName: string }[] {
  return msg.content
    .filter((c) => (c.type === "photo" || c.type === "document") && c.url)
    .map((c) => ({
      url: c.url as string,
      mimeType: c.mimeType ?? "application/octet-stream",
      fileName: c.fileName ?? "attachment",
    }));
}
