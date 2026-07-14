import type { PaymentStateType } from "@/graphs/payment.state";
import { interrupt } from "@langchain/langgraph";
import {
  PAYMENT_NODES,
  type InterruptPayload,
  type PaymentDeps,
  type ResumeInput,
} from "./shared";

type ApprovalAction =
  | "apply_payment"
  | "reverse_payment"
  | "create_credit_note"
  | "void_invoice";

const APPROVAL_NAMES: Record<ApprovalAction, string> = {
  apply_payment: "xero_apply_payment",
  reverse_payment: "xero_reverse_payment",
  create_credit_note: "xero_create_credit_note",
  void_invoice: "xero_void_invoice",
};

/**
 * Human-approval gate BEFORE any write — unlike invoices there is no safe DRAFT
 * stage here; a payment/credit/void takes effect the moment it is sent to Xero.
 * The preview states exactly what will change so the user can verify first.
 */
export function makePaymentApprovalNode(deps: PaymentDeps) {
  return {
    name: PAYMENT_NODES.approval,
    node: async (state: PaymentStateType) => {
      const inv = state.resolvedInvoice;
      const docLabel = inv
        ? `${inv.number ?? inv.id}${inv.contactName ? ` (${inv.contactName})` : ""}`
        : "";

      let message: string;
      let ref = inv?.id ?? "";
      let label = docLabel;
      switch (state.action) {
        case "apply_payment": {
          const remaining = (inv?.amountDue ?? 0) - (state.resolvedAmount ?? 0);
          message =
            `Record a payment of ${state.resolvedAmount} against ${docLabel} on ${state.resolvedDate} ` +
            `from ${state.resolvedBankAccount?.name ?? state.resolvedBankAccount?.code}. ` +
            (remaining > 0
              ? `${remaining} will remain outstanding. `
              : `This settles the document in full. `) +
            "Reply 'approve' to record it, or tell me what to change.";
          label = `payment of ${state.resolvedAmount} for ${docLabel}`;
          break;
        }
        case "reverse_payment":
          message =
            `Reverse (delete) the payment of ${state.resolvedAmount} dated ${state.resolvedDate}` +
            `${inv?.number ? ` against ${inv.number}` : ""}. The document's balance will reopen. ` +
            "Reply 'approve' to reverse it.";
          ref = state.resolvedPaymentId ?? "";
          label = `reversal of payment ${state.resolvedAmount}`;
          break;
        case "create_credit_note": {
          const alloc = state.resolvedAllocationInvoice;
          message =
            `Create a credit note of ${state.resolvedAmount} for ${state.contactName}` +
            (alloc
              ? ` and apply it to ${alloc.number ?? alloc.id} (${Math.min(
                  state.resolvedAmount ?? 0,
                  alloc.amountDue ?? 0,
                )} will be allocated)`
              : "") +
            ". Reply 'approve' to create it.";
          ref = state.resolvedContactId ?? "";
          label = `credit note ${state.resolvedAmount} for ${state.contactName}`;
          break;
        }
        case "void_invoice":
          message =
            `Void ${docLabel} — this cancels the document in Xero and cannot be undone. ` +
            "Reply 'approve' to void it.";
          label = `void ${docLabel}`;
          break;
        default:
          return {
            approved: false,
            result: {
              status: "failed" as const,
              invoiceId: inv?.id,
              summary: `Unsupported payment action: ${state.action ?? "unknown"}. Nothing was recorded in Xero.`,
            },
            _nextNode: PAYMENT_NODES.finalize,
          };
      }

      const payload: InterruptPayload = {
        kind: "approval",
        message,
        approval: {
          name: APPROVAL_NAMES[state.action],
          provider: "xero",
          items: [{ ref, label }],
        },
      };
      const decision = interrupt<InterruptPayload, ResumeInput>(payload);
      const approved = decision.approved === true;
      deps.logger.info(
        { approved, action: state.action },
        "payment approval decision",
      );

      if (!approved) {
        return {
          approved: false,
          result: {
            status: "rejected" as const,
            invoiceId: inv?.id,
            summary: "Cancelled — nothing was recorded in Xero.",
          },
          _nextNode: PAYMENT_NODES.finalize,
        };
      }
      return { approved: true, _nextNode: PAYMENT_NODES.execute };
    },
  };
}
