import type { InvoiceStateType } from "@/graphs/invoice.state";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

/**
 * Attach the original file(s) to the Xero draft (mirrors `xero_attach_to_invoice`).
 * Best-effort: a failed attachment is logged and skipped — it never blocks the draft/approval.
 * Re-downloads bytes here (presigned URL valid ~24h) rather than storing them in checkpoint state.
 */
export function makeAttachInvoiceFileNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.attach,
    node: async (state: InvoiceStateType) => {
      const attachments = state.attachments ?? [];
      if (!deps.fetchAttachment || !state.invoiceId || attachments.length === 0) {
        return { _nextNode: INVOICE_NODES.approval };
      }

      emitProgress(deps, state.threadId, "attach", "Attaching the original file(s)...");
      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        for (const a of attachments) {
          try {
            const fetched = await deps.fetchAttachment(a.url, a.mimeType);
            if (!fetched) continue;
            await deps.xeroTool.attachToInvoice(
              auth,
              state.invoiceId,
              a.fileName,
              fetched.bytes,
              fetched.contentType,
            );
          } catch (err) {
            deps.logger.error({ err, fileName: a.fileName }, "attach one file failed");
          }
        }
      } catch (err) {
        deps.logger.error({ err }, "attach-invoice-file failed");
      }
      return { _nextNode: INVOICE_NODES.approval };
    },
  };
}
