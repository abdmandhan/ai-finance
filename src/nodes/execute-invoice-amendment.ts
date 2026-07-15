import { invoiceLineTotal } from "@/commons";
import type { InvoiceStateType } from "@/graphs/invoice.state";
import type {
  XeroCreditNoteInput,
  XeroInvoiceDetail,
  XeroInvoiceInput,
  XeroInvoiceUpdateInput,
  XeroLineItem,
} from "@/tools";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

function originalInvoice(state: InvoiceStateType): XeroInvoiceDetail | null {
  return (state.originalInvoice as XeroInvoiceDetail | undefined) ?? null;
}

function amendmentInvoice(
  state: InvoiceStateType,
): XeroInvoiceUpdateInput | null {
  return (state.amendmentInvoice as XeroInvoiceUpdateInput | undefined) ?? null;
}

function creditLines(original: XeroInvoiceDetail): XeroLineItem[] {
  if (original.LineItems?.length) return original.LineItems;
  return [
    {
      Description: `Credit ${original.InvoiceNumber ?? original.InvoiceID}`,
      Quantity: 1,
      UnitAmount: original.Total ?? 0,
    },
  ];
}

function replacementReference(
  original: XeroInvoiceDetail,
  next: XeroInvoiceUpdateInput,
) {
  return (
    next.Reference ??
    `Correction for ${original.InvoiceNumber ?? original.Reference ?? original.InvoiceID}`
  );
}

export function makeExecuteInvoiceAmendmentNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.executeAmendment,
    node: async (state: InvoiceStateType) => {
      const original = originalInvoice(state);
      const next = amendmentInvoice(state);
      if (!state.approved || !original || !next) {
        return {
          result: {
            status: "failed" as const,
            summary: "Cannot amend without an approved amendment preview.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      emitProgress(
        deps,
        state.threadId,
        "execute_amendment",
        "Applying the invoice amendment...",
      );

      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        if (state.amendmentMode === "correction") {
          const note: XeroCreditNoteInput = {
            Type: "ACCRECCREDIT",
            Contact: { ContactID: original.Contact?.ContactID ?? "" },
            LineItems: creditLines(original),
            Date: state.date ?? new Date().toISOString().slice(0, 10),
            Reference: `Correction for ${original.InvoiceNumber ?? original.InvoiceID}`,
            CurrencyCode: original.CurrencyCode,
            Status: "AUTHORISED",
          };
          const [creditNote] = await deps.xeroTool.createCreditNotes(auth, [
            note,
          ]);
          const replacement: XeroInvoiceInput = {
            Type: "ACCREC",
            Contact: { ContactID: original.Contact?.ContactID ?? "" },
            LineItems: next.LineItems ?? creditLines(original),
            Status: "AUTHORISED",
            Reference: replacementReference(original, next),
            ...(next.Date
              ? { Date: next.Date }
              : original.Date
                ? { Date: original.Date }
                : {}),
            ...(next.DueDate
              ? { DueDate: next.DueDate }
              : original.DueDate
                ? { DueDate: original.DueDate }
                : {}),
            ...(next.CurrencyCode
              ? { CurrencyCode: next.CurrencyCode }
              : original.CurrencyCode
                ? { CurrencyCode: original.CurrencyCode }
                : {}),
          };
          const [created] = await deps.xeroTool.createInvoices(auth, [
            replacement,
          ]);
          const summary = `Corrected ${original.InvoiceNumber ?? "invoice"} with credit note ${creditNote?.CreditNoteID ?? ""} and replacement invoice ${created?.InvoiceID ?? ""}.`;
          return {
            creditNoteId: creditNote?.CreditNoteID,
            invoiceId: created?.InvoiceID,
            result: {
              status: "corrected" as const,
              invoiceId: created?.InvoiceID,
              creditNoteId: creditNote?.CreditNoteID,
              summary,
              completedApproval: {
                name: "xero_amend_invoice",
                provider: "xero",
                ref: created?.InvoiceID ?? original.InvoiceID,
                label: summary,
                items: [
                  {
                    ref: creditNote?.CreditNoteID ?? "",
                    label: `credit note for ${original.InvoiceNumber ?? original.InvoiceID}`,
                    status: "completed" as const,
                    detail: `Credits ${original.CurrencyCode ?? ""} ${invoiceLineTotal(note.LineItems)}`,
                  },
                  {
                    ref: created?.InvoiceID ?? "",
                    label: "replacement invoice",
                    status: "completed" as const,
                  },
                ],
              },
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        const updated = await deps.xeroTool.updateInvoice(auth, next);
        const summary = `Amended ${original.InvoiceNumber ?? "invoice"} in Xero.`;
        return {
          invoiceId: updated.InvoiceID,
          result: {
            status: "amended" as const,
            invoiceId: updated.InvoiceID,
            summary,
            completedApproval: {
              name: "xero_amend_invoice",
              provider: "xero",
              ref: updated.InvoiceID,
              label: summary,
            },
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "execute-invoice-amendment failed");
        return {
          result: {
            status: "failed" as const,
            invoiceId: original.InvoiceID,
            summary: "Could not apply the invoice amendment.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
