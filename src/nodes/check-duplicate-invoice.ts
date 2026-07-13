import type { InvoiceStateType } from "@/graphs/invoice.state";
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
 * XERO-ERR-010): a non-voided document with the same contact + reference already
 * in Xero pauses the graph and asks before creating a second one. Skipped when
 * no reference was extracted — nothing reliable to match on.
 */
export function makeCheckDuplicateInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.checkDuplicate,
    node: async (state: InvoiceStateType) => {
      if (!state.reference || !state.contactId) {
        return { _nextNode: INVOICE_NODES.createDraft };
      }

      emitProgress(
        deps,
        state.threadId,
        "check_duplicate",
        "Checking for duplicates...",
      );
      let existing;
      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        const hits = await deps.xeroTool.getInvoices(auth, {
          contactId: state.contactId,
          reference: state.reference,
        });
        existing = hits.find((i) => i.Status !== "VOIDED" && i.Status !== "DELETED");
      } catch (err) {
        // The duplicate check is best-effort — never block the workflow on it.
        deps.logger.error({ err }, "duplicate check failed — continuing");
        return { _nextNode: INVOICE_NODES.createDraft };
      }
      if (!existing) {
        return { _nextNode: INVOICE_NODES.createDraft };
      }

      const payload: InterruptPayload = {
        kind: "clarification",
        message:
          `A document with reference ${state.reference} for ${state.contactName} already exists in Xero ` +
          `(${existing.InvoiceNumber ?? existing.InvoiceID}, status ${existing.Status}). ` +
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
          invoiceId: existing.InvoiceID,
          summary: `Skipped — ${existing.InvoiceNumber ?? "the existing document"} with reference ${state.reference} already covers this.`,
        },
        _nextNode: INVOICE_NODES.finalize,
      };
    },
  };
}
