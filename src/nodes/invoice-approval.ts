import type { InvoiceStateType } from "@/graphs/invoice.state";
import { interrupt } from "@langchain/langgraph";
import {
  INVOICE_NODES,
  type InterruptPayload,
  type InvoiceDeps,
  type ResumeInput,
} from "./shared";

/**
 * Human-approval gate. The DRAFT already exists in Xero; authorising is high-risk, so the graph
 * pauses (durably) and emits `approvalData` (pending). Approve → authorise; reject → leave as draft.
 * Mirrors the openclaw draft → approve → authorise contract (never authorise without approval).
 */
export function makeInvoiceApprovalNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.approval,
    node: async (state: InvoiceStateType) => {
      const isAmendment = state.action === "amend_invoice";
      const kind = state.docType === "sales" ? "invoice" : "bill";
      // Surface what was read from the document so the user can verify before authorising.
      const extras: string[] = [];
      if (state.serviceChargeAmount && state.serviceChargeAmount > 0) {
        extras.push(`service charge ${state.serviceChargeAmount}`);
      }
      if (state.taxRatePercent && state.taxRatePercent > 0) {
        const incl = state.amountsAreTaxInclusive ? "incl." : "plus";
        extras.push(
          `${incl} ${state.taxRatePercent}% tax${state.taxAmount ? ` (${state.taxAmount})` : ""}`,
        );
      }
      const detail = extras.length ? ` (${extras.join("; ")})` : "";
      const context: string[] = [];
      if (
        state.customerArBalance !== null &&
        state.customerArBalance !== undefined
      ) {
        context.push(`Customer AR balance: ${state.customerArBalance}`);
      }
      if (state.fxWarning) context.push(state.fxWarning);
      const contextText = context.length ? `\n${context.join("\n")}` : "";
      const message = isAmendment
        ? `Amendment preview for ${state.contactName}:\n${state.amendmentPreview ?? "No details available."}${contextText}\nReply 'approve' to apply this amendment, or reject to leave Xero unchanged.`
        : `Draft ${kind} for ${state.contactName}${detail}${contextText} is ready. Reply 'approve' to authorise, or tell me what to change.`;

      const payload: InterruptPayload = {
        kind: "approval",
        message,
        approval: {
          name: isAmendment
            ? "xero_amend_invoice"
            : state.docType === "sales"
              ? "xero_authorise_invoice"
              : "xero_authorise_bill",
          provider: "xero",
          items: [
            {
              ref:
                state.invoiceId ??
                String(
                  (state.originalInvoice as { InvoiceID?: string } | undefined)
                    ?.InvoiceID ?? "",
                ),
              label: isAmendment
                ? `amend ${String((state.originalInvoice as { InvoiceNumber?: string } | undefined)?.InvoiceNumber ?? "invoice")}`
                : `${kind} for ${state.contactName}`,
            },
          ],
        },
      };
      const decision = interrupt<InterruptPayload, ResumeInput>(payload);
      const approved = decision.approved === true;
      deps.logger.info({ approved }, "invoice approval decision");

      if (!approved) {
        return {
          approved: false,
          result: {
            status: "rejected" as const,
            invoiceId: state.invoiceId ?? undefined,
            summary: isAmendment
              ? "Rejected amendment — Xero was left unchanged."
              : "Left as a draft — nothing was authorised.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
      return {
        approved: true,
        _nextNode: isAmendment
          ? INVOICE_NODES.executeAmendment
          : INVOICE_NODES.authorise,
      };
    },
  };
}
