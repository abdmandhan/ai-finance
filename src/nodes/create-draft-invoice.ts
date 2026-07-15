import type { InvoiceStateType } from "@/graphs/invoice.state";
import {
  applyLineDefaults,
  duePolicyFromContact,
  matchTaxRate,
  resolveOrgDefaults,
  resolveDueDate,
  taxRatePercentOf,
} from "@/commons";
import type {
  InvoiceRetainer,
  XeroContact,
  XeroInvoiceInput,
  XeroLineItem,
} from "@/tools";
import { interrupt } from "@langchain/langgraph";
import {
  emitProgress,
  INVOICE_NODES,
  type InterruptPayload,
  type InvoiceDeps,
  type ResumeInput,
} from "./shared";

function retainerLine(retainer: InvoiceRetainer): XeroLineItem[] {
  if (retainer.lines?.length) {
    return retainer.lines.map((line) => ({
      Description: line.description,
      Quantity: line.quantity,
      UnitAmount: line.unitAmount,
      ...(retainer.accountCode ? { AccountCode: retainer.accountCode } : {}),
      ...(retainer.taxType ? { TaxType: retainer.taxType } : {}),
    }));
  }
  return [
    {
      Description: retainer.description ?? retainer.name,
      Quantity: 1,
      UnitAmount: retainer.amount,
      ...(retainer.accountCode ? { AccountCode: retainer.accountCode } : {}),
      ...(retainer.taxType ? { TaxType: retainer.taxType } : {}),
    },
  ];
}

async function resolveRetainerLines(
  deps: InvoiceDeps,
  state: InvoiceStateType,
): Promise<{
  lines?: XeroLineItem[];
  currencyCode?: string;
  duePolicy?: string | null;
  error?: string;
}> {
  if (!state.useRetainer) return {};
  if (!deps.invoiceRetainersTool) {
    return { error: "No retainer store is configured for this environment." };
  }
  const matches = await deps.invoiceRetainersTool.findActive({
    tenantId: state.tenantId,
    contactId: state.contactId,
    contactName: state.contactName ?? "",
    name: state.retainerName,
  });
  if (!matches.length) {
    return { error: "No active retainer matched this customer." };
  }
  let selected = matches[0];
  if (matches.length > 1 && !state.retainerName) {
    const payload: InterruptPayload = {
      kind: "clarification",
      message: `I found multiple active retainers for ${state.contactName}: ${matches
        .map((r) => r.name)
        .join(", ")}. Which retainer should I use?`,
    };
    const reply = interrupt<InterruptPayload, ResumeInput>(payload);
    const text = (reply.reply ?? "").trim().toLowerCase();
    const chosen = matches.find((r) => r.name.toLowerCase() === text);
    if (!chosen) return { error: "No retainer was selected." };
    selected = chosen;
  }
  return {
    lines: retainerLine(selected),
    currencyCode: selected.currencyCode,
    duePolicy: selected.duePolicy,
  };
}

/**
 * Create the Xero DRAFT invoice/bill. Auto-fills AccountCode/TaxType from the org so the draft
 * is authorise-ready (ports `applyLineDefaults`). ACCREC = sales, ACCPAY = supplier bill.
 */
export function makeCreateDraftInvoiceNode(deps: InvoiceDeps) {
  return {
    name: INVOICE_NODES.createDraft,
    node: async (state: InvoiceStateType) => {
      if (
        !state.contactId ||
        (!state.lineItems?.length && !state.useRetainer)
      ) {
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

        const retainer = await resolveRetainerLines(deps, state);
        if (retainer.error) {
          return {
            result: {
              status: "failed" as const,
              summary: retainer.error,
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }

        const lines: XeroLineItem[] = (state.lineItems ?? []).map((li) => ({
          Description: li.description,
          Quantity: li.quantity,
          UnitAmount: li.unitAmount,
        }));
        lines.push(...(retainer.lines ?? []));
        if (!lines.length) {
          return {
            result: {
              status: "failed" as const,
              summary: "Missing line items for the draft.",
            },
            _nextNode: INVOICE_NODES.finalize,
          };
        }
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
        applyLineDefaults(lines, {
          accountCode: defaults.accountCode,
          taxType,
        });

        // Service charge is a genuine line (taxed like the goods), not a tax.
        if (state.serviceChargeAmount && state.serviceChargeAmount > 0) {
          lines.push({
            Description: "Service charge",
            Quantity: 1,
            UnitAmount: state.serviceChargeAmount,
            ...(defaults.accountCode
              ? { AccountCode: defaults.accountCode }
              : {}),
            ...(taxType ? { TaxType: taxType } : {}),
          });
        }

        const org = await deps.xeroTool.getOrganisation(auth);
        const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
        const due = resolveDueDate({
          invoiceDate: state.date,
          explicitDueDate: state.dueDate,
          duePolicy: state.duePolicy ?? retainer.duePolicy ?? null,
          contact: state.customer as XeroContact | undefined,
          today,
        });
        const currencyCode =
          state.currencyCode ?? retainer.currencyCode ?? undefined;
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
            state.date ?? today,
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

        const invoice: XeroInvoiceInput = {
          Type: isSales ? "ACCREC" : "ACCPAY",
          Contact: { ContactID: state.contactId },
          LineItems: lines,
          Status: "DRAFT",
          LineAmountTypes: state.amountsAreTaxInclusive
            ? "Inclusive"
            : "Exclusive",
          ...(state.reference ? { Reference: state.reference } : {}),
          ...(state.date ? { Date: state.date } : {}),
          ...(due.dueDate ? { DueDate: due.dueDate } : {}),
          ...(currencyCode ? { CurrencyCode: currencyCode } : {}),
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
          dueDate: due.dueDate ?? state.dueDate,
          duePolicy:
            state.duePolicy ??
            retainer.duePolicy ??
            duePolicyFromContact(state.customer as XeroContact | undefined),
          currencyCode: currencyCode ?? state.currencyCode,
          fxRate,
          fxWarning,
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
