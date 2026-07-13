import type { PaymentStateType } from "@/graphs/payment.state";
import { emitProgress, PAYMENT_NODES, type PaymentDeps } from "./shared";

/**
 * The single write step, reached only through the approval gate. Exactly one Xero
 * operation per run (plus the optional credit-note allocation the user approved).
 */
export function makeExecutePaymentNode(deps: PaymentDeps) {
  return {
    name: PAYMENT_NODES.execute,
    node: async (state: PaymentStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "execute_payment",
        "Recording in Xero...",
      );
      const auth = await deps.resolveXeroAuth(state.tenantId);
      const inv = state.resolvedInvoice;

      try {
        switch (state.action) {
          case "apply_payment": {
            const [payment] = await deps.xeroTool.createPayments(auth, [
              {
                Invoice: { InvoiceID: inv!.id },
                Account: { Code: state.resolvedBankAccount!.code },
                Date: state.resolvedDate!,
                Amount: state.resolvedAmount!,
                ...(state.reference ? { Reference: state.reference } : {}),
              },
            ]);
            const remaining = (inv?.amountDue ?? 0) - (state.resolvedAmount ?? 0);
            return {
              result: {
                status: "created" as const,
                paymentId: payment?.PaymentID,
                invoiceId: inv?.id,
                remainingAmountDue: Math.max(0, remaining),
                summary:
                  `Recorded a payment of ${state.resolvedAmount} against ${inv?.number ?? inv?.id}.` +
                  (remaining > 0
                    ? ` ${remaining} remains outstanding.`
                    : " The document is now fully paid."),
              },
            };
          }
          case "reverse_payment": {
            await deps.xeroTool.deletePayment(auth, state.resolvedPaymentId!);
            return {
              result: {
                status: "reversed" as const,
                paymentId: state.resolvedPaymentId ?? undefined,
                invoiceId: inv?.id,
                summary: `Reversed the payment of ${state.resolvedAmount} dated ${state.resolvedDate}${inv?.number ? ` against ${inv.number}` : ""}. The balance is open again.`,
              },
            };
          }
          case "create_credit_note": {
            const [note] = await deps.xeroTool.createCreditNotes(auth, [
              {
                Type:
                  state.targetKind === "bill" ? "ACCPAYCREDIT" : "ACCRECCREDIT",
                Contact: { ContactID: state.resolvedContactId! },
                LineItems: (state.creditNoteLines ?? []).map((l) => ({
                  Description: l.description,
                  Quantity: l.quantity,
                  UnitAmount: l.unitAmount,
                })),
                Date: state.resolvedDate ?? undefined,
                Status: "AUTHORISED",
                ...(state.reference ? { Reference: state.reference } : {}),
              },
            ]);
            let allocated = 0;
            const alloc = state.resolvedAllocationInvoice;
            if (note && alloc) {
              // Never allocate more than either balance (XERO-PAY-007).
              allocated = Math.min(
                state.resolvedAmount ?? 0,
                alloc.amountDue ?? 0,
              );
              if (allocated > 0)
                await deps.xeroTool.allocateCreditNote(auth, note.CreditNoteID, {
                  InvoiceID: alloc.id,
                  Amount: allocated,
                });
            }
            return {
              result: {
                status: "created" as const,
                creditNoteId: note?.CreditNoteID,
                invoiceId: alloc?.id,
                summary:
                  `Created credit note ${note?.CreditNoteNumber ?? ""} of ${state.resolvedAmount} for ${state.contactName}.` +
                  (allocated > 0
                    ? ` Applied ${allocated} to ${alloc?.number ?? alloc?.id}.`
                    : ""),
              },
            };
          }
          default: {
            // void_invoice
            await deps.xeroTool.updateInvoiceStatus(auth, inv!.id, "VOIDED");
            return {
              result: {
                status: "voided" as const,
                invoiceId: inv?.id,
                summary: `Voided ${inv?.number ?? inv?.id}.`,
              },
            };
          }
        }
      } catch (err) {
        deps.logger.error({ err }, "execute-payment failed");
        return {
          result: {
            status: "failed" as const,
            invoiceId: inv?.id,
            summary: `Xero rejected the operation: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    },
  };
}
