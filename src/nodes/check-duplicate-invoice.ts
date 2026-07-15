import type { InvoiceStateType } from "@/graphs/invoice.state";
import {
  invoiceDateWindowAround,
  invoiceLineSignature,
  invoiceLineTotal,
  scoreDuplicateInvoice,
} from "@/commons";
import { interrupt } from "@langchain/langgraph";
import {
  emitProgress,
  INVOICE_NODES,
  type InterruptPayload,
  type InvoiceDeps,
  type ResumeInput,
} from "./shared";

/**
 * Duplicate guard before the draft is created (XERO-DOC-029 / XERO-INV-018 /
 * XERO-ERR-010): pause on a 90-day, 3-of-4 match using customer, amount,
 * line-item signature, and reference/billing marker.
 */
export function makeCheckDuplicateInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.checkDuplicate,
    node: async (state: InvoiceStateType) => {
      if (!state.contactId || !state.lineItems?.length) {
        return { _nextNode: INVOICE_NODES.createDraft };
      }

      emitProgress(
        deps,
        state.threadId,
        "check_duplicate",
        "Checking for duplicates...",
      );
      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
      const invoiceDate = state.date ?? today;
      const window = invoiceDateWindowAround(invoiceDate, 90);
      const total = invoiceLineTotal(state.lineItems);
      const lineSignature = invoiceLineSignature(state.lineItems);
      let existing;
      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        const hits = await deps.xeroTool.getInvoices(auth, {
          contactId: state.contactId,
          type: state.docType === "bill" ? "ACCPAY" : "ACCREC",
          dateFrom: window.from,
          dateTo: window.to,
        });
        existing = hits
          .filter((i) => i.Status !== "VOIDED" && i.Status !== "DELETED")
          .map((invoice) =>
            scoreDuplicateInvoice(invoice, {
              contactId: state.contactId,
              total,
              lineSignature,
              reference: state.reference,
            }),
          )
          .find((candidate) => candidate.score >= 3);
      } catch (err) {
        // The duplicate check is best-effort — never block the workflow on it.
        deps.logger.error({ err }, "duplicate check failed — continuing");
        return { _nextNode: INVOICE_NODES.createDraft };
      }
      if (!existing) {
        return { _nextNode: INVOICE_NODES.createDraft };
      }

      const inv = existing.invoice;
      const payload: InterruptPayload = {
        kind: "clarification",
        message:
          `A similar document for ${state.contactName} already exists in Xero ` +
          `(${inv.InvoiceNumber ?? inv.InvoiceID}, status ${inv.Status}). ` +
          `Matched ${existing.matched.join(", ")}. ` +
          `Existing total ${inv.Total ?? "unknown"} vs new total ${total}. ` +
          "Reply 'create anyway' to create another one, or 'cancel' to stop.",
      };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);
      deps.logger.info({ reply }, "duplicate check reply");

      const text = reply.reply ?? "";
      const proceed =
        reply.approved === true ||
        /\b(create anyway|yes|proceed|go ahead|approve)\b/i.test(text);
      if (proceed) {
        return { _nextNode: INVOICE_NODES.createDraft };
      }
      return {
        result: {
          status: "rejected" as const,
          invoiceId: inv.InvoiceID,
          summary: `Skipped — ${inv.InvoiceNumber ?? "the existing document"} appears to already cover this.`,
        },
        duplicateCandidate: inv,
        _nextNode: INVOICE_NODES.finalize,
      };
    },
  };
}
