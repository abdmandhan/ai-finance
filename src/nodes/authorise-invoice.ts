import type { InvoiceStateType } from "@/graphs/invoice.state";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

/** Authorise the draft (DRAFT → AUTHORISED). Only reached after explicit approval. */
export function makeAuthoriseInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.authorise,
    node: async (state: InvoiceStateType) => {
      if (!state.approved || !state.invoiceId) {
        return {
          result: {
            status: "failed" as const,
            summary: "Cannot authorise without an approved draft.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      emitProgress(
        deps,
        state.threadId,
        "authorise",
        "Authorising the invoice...",
      );
      const kind = state.docType === "sales" ? "invoice" : "bill";

      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        const authorised = await deps.xeroTool.authoriseInvoice(
          auth,
          state.invoiceId,
        );
        return {
          result: {
            status: "created" as const,
            invoiceId: authorised.InvoiceID,
            summary: `Authorised ${kind} for ${state.contactName}.`,
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "authorise-invoice failed");
        return {
          result: {
            status: "failed" as const,
            invoiceId: state.invoiceId ?? undefined,
            summary:
              "The draft was created but could not be authorised. Please try again.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
