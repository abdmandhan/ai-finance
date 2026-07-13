import type { PaymentStateType } from "@/graphs/payment.state";
import { PAYMENT_NODES, type PaymentDeps } from "./shared";

/** Terminal node — guarantees a `result` so the runtime can always reply. */
export function makeFinalizePaymentNode(deps: PaymentDeps) {
  return {
    name: PAYMENT_NODES.finalize,
    node: async (state: PaymentStateType) => {
      const result = state.result ?? {
        status: "failed" as const,
        summary: "Workflow ended without a result.",
      };
      deps.logger.info({ result }, "payment graph finished");
      return { result };
    },
  };
}
