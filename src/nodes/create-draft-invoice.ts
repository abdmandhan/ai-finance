import type { InvoiceStateType } from "@/graphs/invoice.state";
import {
  applyLineDefaults,
  matchTaxRate,
  resolveOrgDefaults,
  taxRatePercentOf,
} from "@/commons";
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

        const defaults = resolveOrgDefaults(
          accounts,
          taxRates,
          isSales ? "REVENUE" : "EXPENSE",
          deps.orgDefaults,
        );
        // Apply the receipt's GST: if the org account's default tax is 0% but the document shows a
        // tax rate, override with a matching Xero rate so GST actually posts. Otherwise keep the
        // account default (which is account-compatible — see the tax/account fix).
        let taxType = defaults.taxType;
        const wantPercent = state.taxRatePercent ?? 0;
        if (wantPercent > 0 && taxRatePercentOf(taxRates, taxType) === 0) {
          taxType = matchTaxRate(taxRates, wantPercent) ?? taxType;
        }
        applyLineDefaults(lines, { accountCode: defaults.accountCode, taxType });

        // Service charge is a genuine line (taxed like the goods), not a tax.
        if (state.serviceChargeAmount && state.serviceChargeAmount > 0) {
          lines.push({
            Description: "Service charge",
            Quantity: 1,
            UnitAmount: state.serviceChargeAmount,
            ...(defaults.accountCode ? { AccountCode: defaults.accountCode } : {}),
            ...(taxType ? { TaxType: taxType } : {}),
          });
        }

        const invoice: XeroInvoiceInput = {
          Type: isSales ? "ACCREC" : "ACCPAY",
          Contact: { ContactID: state.contactId },
          LineItems: lines,
          Status: "DRAFT",
          LineAmountTypes: state.amountsAreTaxInclusive ? "Inclusive" : "Exclusive",
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
          _nextNode: INVOICE_NODES.attach,
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
