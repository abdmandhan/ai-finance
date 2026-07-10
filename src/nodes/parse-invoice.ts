import type { InvoiceStateType } from "@/graphs/invoice.state";
import { invoicePrompts } from "@/prompts";
import { invoiceIntentSchema } from "@/schemas";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  emitProgress,
  INVOICE_NODES,
  MAX_CLARIFY_ATTEMPTS,
  type InvoiceDeps,
} from "./shared";

/**
 * Extract invoice/bill fields. The LLM extracts + flags missing info; this node routes
 * (clarify vs resolve-contact vs fail).
 */
export function makeParseInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.parseInvoice,
    node: async (state: InvoiceStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "parse_invoice",
        "Reading the invoice details...",
      );

      // Build a multimodal message: text + any attached images (downloaded → base64) so a
      // vision model can read the invoice/receipt. All images go in one message (one document).
      const imageParts: Array<{
        type: "image_url";
        image_url: { url: string };
      }> = [];
      const attachments = state.attachments ?? [];
      if (deps.fetchAttachment && attachments.length) {
        const images = attachments
          .filter((a) => a.mimeType?.startsWith("image/"))
          .slice(0, 5);
        for (const a of images) {
          const fetched = await deps.fetchAttachment(a.url, a.mimeType);
          if (fetched?.dataUrl) {
            imageParts.push({
              type: "image_url",
              image_url: { url: fetched.dataUrl },
            });
          }
        }
        emitProgress(
          deps,
          state.threadId,
          "parse_invoice",
          `Read ${imageParts.length} image(s)`,
        );
      }

      const humanContent = imageParts.length
        ? [{ type: "text" as const, text: state.userMessage }, ...imageParts]
        : state.userMessage;
      const messages = [
        new SystemMessage(invoicePrompts.parseInvoicePrompt()),
        new HumanMessage({ content: humanContent }),
      ];
      const extracted = await deps.llmService.extract(
        invoiceIntentSchema,
        messages,
        "invoice_intent",
      );
      deps.logger.info({ extracted }, "parse-invoice result");

      if (extracted.docType === "unsupported") {
        return {
          docType: extracted.docType,
          result: {
            status: "failed" as const,
            summary: "This does not look like an invoicing request.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      const contactName = extracted.contactName ?? state.contactName;
      const lineItems = extracted.lineItems.length
        ? extracted.lineItems
        : state.lineItems;
      const missing = !contactName || !lineItems || lineItems.length === 0;

      if (
        missing &&
        extracted.clarificationQuestion &&
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
      ) {
        return {
          docType: extracted.docType,
          contactName,
          lineItems,
          reference: extracted.reference ?? state.reference,
          date: extracted.date ?? state.date,
          dueDate: extracted.dueDate ?? state.dueDate,
          currencyCode: extracted.currencyCode ?? state.currencyCode,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: INVOICE_NODES.askClarification,
        };
      }

      if (missing) {
        return {
          docType: extracted.docType,
          result: {
            status: "failed" as const,
            summary: "Not enough information to create the invoice.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      return {
        docType: extracted.docType,
        contactName,
        lineItems,
        reference: extracted.reference ?? state.reference,
        date: extracted.date ?? state.date,
        dueDate: extracted.dueDate ?? state.dueDate,
        currencyCode: extracted.currencyCode ?? state.currencyCode,
        clarificationQuestion: null,
        _nextNode: INVOICE_NODES.resolveContact,
      };
    },
  };
}
