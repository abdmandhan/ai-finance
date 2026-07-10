import type { InvoiceStateType } from "@/graphs/invoice.state";
import { INVOICE_NODES, type InvoiceDeps } from "./shared";

/** Terminal node — guarantees a `result` so the runtime can always reply. */
export function makeFinalizeInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.finalize,
    node: async (state: InvoiceStateType) => {
      const result = state.result ?? {
        status: "failed" as const,
        summary: "Workflow ended without a result.",
      };
      deps.logger.info({ result }, "invoice graph finished");
      return { result };
    },
  };
}
