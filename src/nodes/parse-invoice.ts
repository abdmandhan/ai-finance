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

      if (
        (extracted.action === "unsupported" ||
        extracted.docType === "unsupported"
        ) &&
        extracted.action !== "generate_invoice_pdf"
      ) {
        return {
          action: extracted.action,
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
      const action = extracted.action ?? state.action ?? "create_invoice";
      const retainer = extracted.retainer ?? state.retainer ?? null;
      const targetInvoiceRef =
        extracted.targetInvoiceRef ?? state.targetInvoiceRef ?? null;
      const fileName = extracted.fileName ?? state.fileName ?? null;
      const useRetainer =
        extracted.useRetainer ||
        state.useRetainer ||
        Boolean(extracted.retainerName);
      const hasInvoiceChanges =
        Boolean(extracted.reference) ||
        Boolean(extracted.date) ||
        Boolean(extracted.dueDate) ||
        Boolean(extracted.duePolicy) ||
        Boolean(extracted.currencyCode) ||
        (extracted.lineItems?.length ?? 0) > 0;

      const missing =
        action === "generate_invoice_pdf"
          ? false
          : action === "amend_invoice"
          ? !targetInvoiceRef || !hasInvoiceChanges
          : action === "create_retainer" || action === "update_retainer"
            ? !contactName || !retainer?.amount || !retainer.currencyCode
            : action === "delete_retainer"
              ? !contactName
              : action === "list_retainers"
                ? false
                : !contactName ||
                  ((!lineItems || lineItems.length === 0) && !useRetainer);

      if (
        missing &&
        extracted.clarificationQuestion &&
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
      ) {
        return {
          action,
          docType: extracted.docType,
          contactName,
          lineItems,
          reference: extracted.reference ?? state.reference,
          date: extracted.date ?? state.date,
          dueDate: extracted.dueDate ?? state.dueDate,
          duePolicy: extracted.duePolicy ?? state.duePolicy,
          currencyCode: extracted.currencyCode ?? state.currencyCode,
          targetInvoiceRef,
          fileName,
          amendmentReason: extracted.amendmentReason ?? state.amendmentReason,
          quotedFxRate: extracted.quotedFxRate ?? state.quotedFxRate,
          useRetainer,
          retainerName: extracted.retainerName ?? state.retainerName,
          retainer,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: INVOICE_NODES.askClarification,
        };
      }

      if (missing) {
        return {
          action,
          docType: extracted.docType,
          result: {
            status: "failed" as const,
            summary: "Not enough information to create the invoice.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      const nextNode =
        action === "generate_invoice_pdf"
          ? INVOICE_NODES.generatePdf
          : action === "amend_invoice"
          ? INVOICE_NODES.prepareAmendment
          : action === "create_retainer" ||
              action === "update_retainer" ||
              action === "delete_retainer" ||
              action === "list_retainers"
            ? INVOICE_NODES.manageRetainer
            : INVOICE_NODES.resolveContact;

      return {
        action,
        docType: extracted.docType,
        contactName,
        lineItems,
        reference: extracted.reference ?? state.reference,
        date: extracted.date ?? state.date,
        dueDate: extracted.dueDate ?? state.dueDate,
        duePolicy: extracted.duePolicy ?? state.duePolicy,
        currencyCode: extracted.currencyCode ?? state.currencyCode,
        targetInvoiceRef,
        fileName,
        amendmentReason: extracted.amendmentReason ?? state.amendmentReason,
        quotedFxRate: extracted.quotedFxRate ?? state.quotedFxRate,
        useRetainer,
        retainerName: extracted.retainerName ?? state.retainerName,
        retainer,
        serviceChargeAmount:
          extracted.serviceChargeAmount ?? state.serviceChargeAmount,
        taxRatePercent: extracted.taxRatePercent ?? state.taxRatePercent,
        taxAmount: extracted.taxAmount ?? state.taxAmount,
        amountsAreTaxInclusive:
          extracted.amountsAreTaxInclusive ?? state.amountsAreTaxInclusive,
        clarificationQuestion: null,
        _nextNode: nextNode,
      };
    },
  };
}
