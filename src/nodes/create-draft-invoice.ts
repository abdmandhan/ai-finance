import type { InvoiceStateType } from "@/graphs/invoice.state";
import { applyLineDefaults, resolveOrgDefaults } from "@/commons";
import type { XeroInvoiceInput, XeroLineItem } from "@/tools";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

/**
 * Create the Xero DRAFT invoice/bill. Auto-fills AccountCode/TaxType from the org so the draft
 * is authorise-ready (ports `applyLineDefaults`). ACCREC = sales, ACCPAY = supplier bill.
 */
export function makeCreateDraftInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.createDraft,
    node: async (state: InvoiceStateType) => {
      if (!state.contactId || !state.lineItems?.length) {
        return {
          result: {
            status: "failed" as const,
            summary: "Missing contact or line items for the draft.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }

      emitProgress(
        deps,
        state.threadId,
        "create_draft",
        "Creating the Xero draft...",
      );
      const isSales = state.docType === "sales";

      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);

        const lines: XeroLineItem[] = state.lineItems.map((li) => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: li.unitAmount,
        }));
        const [accounts, taxRates] = await Promise.all([
          deps.xeroTool.getAccounts(auth),
          deps.xeroTool.getTaxRates(auth),
        ]);
        applyLineDefaults(
          lines,
          resolveOrgDefaults(
            accounts,
            taxRates,
            isSales ? "REVENUE" : "EXPENSE",
            deps.orgDefaults,
          ),
        );

        const invoice: XeroInvoiceInput = {
          Type: isSales ? "ACCREC" : "ACCPAY",
          Contact: { ContactID: state.contactId },
          LineItems: lines,
          Status: "DRAFT",
          ...(state.reference ? { Reference: state.reference } : {}),
          ...(state.date ? { Date: state.date } : {}),
          ...(state.dueDate ? { DueDate: state.dueDate } : {}),
          ...(state.currencyCode ? { CurrencyCode: state.currencyCode } : {}),
        };
        const [created] = await deps.xeroTool.createInvoices(auth, [invoice]);
        if (!created?.InvoiceID) {
          return {
            result: {
              status: "failed" as const,
              summary: "Xero did not return a draft invoice id.",
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }
        deps.logger.info(
          { invoiceId: created.InvoiceID },
          "created Xero draft",
        );
        return {
          invoiceId: created.InvoiceID,
          _nextNode: INVOICE_NODES.approval,
        };
      } catch (err) {
        deps.logger.error({ err }, "create-draft-invoice failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not create the Xero draft. Please try again later.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
