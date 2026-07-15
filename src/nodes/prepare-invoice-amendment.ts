import {
  applyLineDefaults,
  buildAmendmentPreview,
  duePolicyFromContact,
  matchTaxRate,
  resolveDueDate,
  resolveOrgDefaults,
  taxRatePercentOf,
} from "@/commons";
import type { InvoiceStateType } from "@/graphs/invoice.state";
import type {
  XeroContact,
  XeroInvoiceDetail,
  XeroInvoiceUpdateInput,
  XeroLineItem,
} from "@/tools";
import { emitProgress, INVOICE_NODES, type InvoiceDeps } from "./shared";

function existingInvoice(state: InvoiceStateType): XeroInvoiceDetail | null {
  return (state.originalInvoice as XeroInvoiceDetail | undefined) ?? null;
}

function amendmentInvoice(
  state: InvoiceStateType,
): XeroInvoiceUpdateInput | null {
  return (state.amendmentInvoice as XeroInvoiceUpdateInput | undefined) ?? null;
}

export function amendmentState(state: InvoiceStateType) {
  return {
    original: existingInvoice(state),
    next: amendmentInvoice(state),
  };
}

function isClosed(invoice: XeroInvoiceDetail): boolean {
  return invoice.Status === "VOIDED" || invoice.Status === "DELETED";
}

function needsCorrection(invoice: XeroInvoiceDetail): boolean {
  return (
    invoice.Status === "PAID" ||
    (invoice.AmountPaid ?? 0) > 0 ||
    (invoice.AmountCredited ?? 0) > 0
  );
}

async function resolveTargetInvoice(
  deps: InvoiceDeps,
  state: InvoiceStateType,
): Promise<XeroInvoiceDetail | null> {
  const auth = await deps.resolveXeroAuth(state.tenantId);
  const ref = state.targetInvoiceRef ?? "";
  const byNumber = await deps.xeroTool.getInvoices(auth, {
    type: "ACCREC",
    invoiceNumber: ref,
  });
  if (byNumber[0]) return byNumber[0];
  const byReference = await deps.xeroTool.getInvoices(auth, {
    type: "ACCREC",
    reference: ref,
  });
  return byReference[0] ?? null;
}

async function lineItemsFor(
  deps: InvoiceDeps,
  state: InvoiceStateType,
  original: XeroInvoiceDetail,
): Promise<XeroLineItem[]> {
  if (!state.lineItems?.length) return original.LineItems ?? [];
  const lines: XeroLineItem[] = state.lineItems.map((li) => ({
    Description: li.description,
    Quantity: li.quantity,
    UnitAmount: li.unitAmount,
  }));
  const auth = await deps.resolveXeroAuth(state.tenantId);
  const [accounts, taxRates] = await Promise.all([
    deps.xeroTool.getAccounts(auth),
    deps.xeroTool.getTaxRates(auth),
  ]);
  const defaults = resolveOrgDefaults(
    accounts,
    taxRates,
    "REVENUE",
    deps.orgDefaults,
  );
  let taxType = defaults.taxType;
  const wantPercent = state.taxRatePercent ?? 0;
  if (wantPercent > 0 && taxRatePercentOf(taxRates, taxType) === 0) {
    taxType = matchTaxRate(taxRates, wantPercent) ?? taxType;
  }
  applyLineDefaults(lines, { accountCode: defaults.accountCode, taxType });
  return lines;
}

export function makePrepareInvoiceAmendmentNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.prepareAmendment,
    node: async (state: InvoiceStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "prepare_amendment",
        "Finding the invoice to amend...",
      );

      try {
        const auth = await deps.resolveXeroAuth(state.tenantId);
        const original = await resolveTargetInvoice(deps, state);
        if (!original) {
          return {
            result: {
              status: "failed" as const,
              summary: `Could not find sales invoice ${state.targetInvoiceRef ?? ""} in Xero.`,
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }
        if (isClosed(original)) {
          return {
            result: {
              status: "failed" as const,
              invoiceId: original.InvoiceID,
              summary: `Cannot amend ${original.InvoiceNumber ?? "that invoice"} because it is ${original.Status}.`,
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        const contactId = original.Contact?.ContactID;
        const customer = contactId
          ? await deps.xeroTool.getContact(auth, contactId).catch(() => null)
          : null;
        const org = await deps.xeroTool.getOrganisation(auth);
        const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
        const due = resolveDueDate({
          invoiceDate: state.date ?? original.Date,
          explicitDueDate: state.dueDate,
          duePolicy: state.duePolicy,
          contact: customer,
          today,
        });
        const currencyCode = state.currencyCode ?? original.CurrencyCode;
        let fxRate: number | undefined;
        let fxWarning: string | undefined;
        if (
          currencyCode &&
          org.BaseCurrency &&
          currencyCode.toUpperCase() !== org.BaseCurrency.toUpperCase()
        ) {
          const rate = await deps.xeroTool.getCurrencyRate(
            auth,
            currencyCode,
            state.date ?? original.Date ?? today,
          );
          fxRate = rate?.rate;
          if (rate?.rate && state.quotedFxRate) {
            const variance =
              Math.abs(rate.rate - state.quotedFxRate) / rate.rate;
            if (variance > 0.02) {
              fxWarning = `FX variance warning: quoted ${state.quotedFxRate} differs from Xero ${rate.rate} by ${(variance * 100).toFixed(1)}%.`;
            }
          }
        }

        const next: XeroInvoiceUpdateInput = {
          InvoiceID: original.InvoiceID,
          Type: "ACCREC",
          Contact: { ContactID: contactId ?? "" },
          LineItems: await lineItemsFor(deps, state, original),
          ...(state.reference ? { Reference: state.reference } : {}),
          ...(state.date ? { Date: state.date } : {}),
          ...(due.dueDate ? { DueDate: due.dueDate } : {}),
          ...(currencyCode ? { CurrencyCode: currencyCode } : {}),
        };
        const arBalance =
          customer?.ARBalance ??
          customer?.Balances?.AccountsReceivable?.Outstanding ??
          null;
        const preview = buildAmendmentPreview({
          original,
          next: {
            reference: next.Reference,
            date: next.Date,
            dueDate: next.DueDate,
            currencyCode: next.CurrencyCode,
            lineItems: next.LineItems,
          },
          reason: state.amendmentReason,
          fxWarning,
          arBalance,
        });

        return {
          contactName: original.Contact?.Name ?? state.contactName,
          contactId: contactId ?? state.contactId,
          originalInvoice: original,
          amendmentInvoice: next,
          amendmentPreview: preview,
          amendmentMode: needsCorrection(original) ? "correction" : "update",
          dueDate: due.dueDate ?? state.dueDate,
          duePolicy:
            state.duePolicy ??
            duePolicyFromContact(customer as XeroContact | null),
          currencyCode,
          customer,
          customerArBalance: arBalance,
          fxRate,
          fxWarning,
          _nextNode: INVOICE_NODES.approval,
        };
      } catch (err) {
        deps.logger.error({ err }, "prepare-invoice-amendment failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not prepare the invoice amendment.",
          },
          _nextNode: INVOICE_NODES.finalize,
        };
      }
    },
  };
}
