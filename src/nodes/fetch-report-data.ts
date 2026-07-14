import {
  previousEquivalentPeriod,
  reportDataRows,
  reportSectionTotal,
} from "@/commons";
import type { ReportStateType } from "@/graphs/report.state";
import type { InvoiceQuery, XeroInvoiceDetail } from "@/tools";
import { emitProgress, REPORT_NODES, type ReportDeps } from "./shared";

/** Normalized answer data handed to compose-report-answer. */
export type ReportData =
  | {
      kind: "totals";
      revenue?: number;
      expenses?: number;
      profit?: number;
      prev?: { revenue?: number; expenses?: number; profit?: number; label: string };
    }
  | { kind: "balance_sheet"; assets?: number; liabilities?: number; equity?: number }
  | { kind: "rows"; rows: { label: string; value: number }[] }
  | {
      kind: "documents";
      total: number;
      totalsByCurrency: { currency?: string; total: number }[];
      count: number;
      amountKind: "due" | "total";
      docs: {
        number?: string;
        contact?: string;
        date?: string;
        dueDate?: string;
        currency?: string;
        amount: number;
      }[];
    }
  | { kind: "grouped"; groups: { label: string; value: number }[] }
  | {
      kind: "overview";
      revenue?: number;
      expenses?: number;
      profit?: number;
      receivables: number;
      payables: number;
    };

const docView = (
  i: XeroInvoiceDetail,
  baseCurrency: string | null | undefined,
  amountOf: (doc: XeroInvoiceDetail) => number,
) => ({
  number: i.InvoiceNumber,
  contact: i.Contact?.Name,
  date: i.Date,
  dueDate: i.DueDate,
  currency: i.CurrencyCode ?? baseCurrency ?? undefined,
  amount: amountOf(i),
});

const sumDue = (docs: XeroInvoiceDetail[]) =>
  docs.reduce((s, d) => s + (d.AmountDue ?? 0), 0);

function documentData(
  docs: XeroInvoiceDetail[],
  baseCurrency: string | null | undefined,
  amountKind: "due" | "total",
): Extract<ReportData, { kind: "documents" }> {
  const amountOf =
    amountKind === "due"
      ? (doc: XeroInvoiceDetail) => doc.AmountDue ?? 0
      : (doc: XeroInvoiceDetail) => doc.Total ?? doc.AmountDue ?? 0;
  const totals = new Map<string, number>();
  for (const doc of docs) {
    const currency = doc.CurrencyCode ?? baseCurrency ?? "";
    totals.set(currency, (totals.get(currency) ?? 0) + amountOf(doc));
  }
  const totalsByCurrency = [...totals.entries()]
    .map(([currency, total]) => ({ currency: currency || undefined, total }))
    .sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));
  return {
    kind: "documents",
    total: docs.reduce((sum, doc) => sum + amountOf(doc), 0),
    totalsByCurrency,
    count: docs.length,
    amountKind,
    docs: docs.map((doc) => docView(doc, baseCurrency, amountOf)),
  };
}

/**
 * Fetch and aggregate — all deterministic. P&L-style questions use Xero report
 * endpoints; unpaid/overdue lists use typed invoice queries (never counting
 * PAID/VOIDED documents); grouping/top-N/deltas are computed in code.
 */
export function makeFetchReportDataNode(deps: ReportDeps) {
  return {
    name: REPORT_NODES.fetchData,
    node: async (state: ReportStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "fetch_report_data",
        "Fetching from Xero...",
      );
      const auth = await deps.resolveXeroAuth(state.tenantId);
      const period = state.period!;
      const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

      const pnl = (from: string, to: string) =>
        deps.xeroTool.getReport(auth, "ProfitAndLoss", {
          fromDate: from,
          toDate: to,
        });
      const pnlTotals = async (from: string, to: string) => {
        const report = await pnl(from, to);
        return {
          revenue: reportSectionTotal(report, "income"),
          expenses: reportSectionTotal(report, "operating expenses"),
          profit: reportSectionTotal(report, "net profit"),
          report,
        };
      };
      const invoiceDateWindow = (enabled: boolean) =>
        enabled && !period.defaulted
          ? { dateFrom: period.from, dateTo: period.to }
          : {};
      const openDocs = (
        extra: Partial<InvoiceQuery>,
        opts: { dateWindow?: boolean } = {},
      ) =>
        deps.xeroTool.getInvoices(auth, {
          statuses: ["AUTHORISED"],
          unpaidOnly: true,
          ...(state.minAmount != null ? { amountDueMin: state.minAmount } : {}),
          ...invoiceDateWindow(opts.dateWindow ?? true),
          ...extra,
        });
      const statusDocs = (extra: Partial<InvoiceQuery>) =>
        deps.xeroTool.getInvoices(auth, {
          ...invoiceDateWindow(true),
          ...extra,
        });

      try {
        let data: ReportData;
        switch (state.metric) {
          case "expenses":
          case "revenue":
          case "profit": {
            const { revenue, expenses, profit } = await pnlTotals(
              period.from,
              period.to,
            );
            let prev;
            if (state.compareToPrevious) {
              const prevPeriod = previousEquivalentPeriod(period);
              const p = await pnlTotals(prevPeriod.from, prevPeriod.to);
              prev = {
                revenue: p.revenue,
                expenses: p.expenses,
                profit: p.profit,
                label: prevPeriod.label,
              };
            }
            data = { kind: "totals", revenue, expenses, profit, prev };
            break;
          }
          case "balance_sheet": {
            const report = await deps.xeroTool.getReport(auth, "BalanceSheet", {
              date: period.to,
            });
            data = {
              kind: "balance_sheet",
              assets: reportSectionTotal(report, "total assets"),
              liabilities: reportSectionTotal(report, "total liabilities"),
              equity: reportSectionTotal(report, "total equity"),
            };
            break;
          }
          case "cash": {
            const report = await deps.xeroTool.getReport(auth, "BankSummary", {
              fromDate: period.from,
              toDate: period.to,
            });
            data = { kind: "rows", rows: reportDataRows(report) };
            break;
          }
          case "top_expenses":
          case "expenses_by_category": {
            const report = await pnl(period.from, period.to);
            let rows = reportDataRows(report, "expenses").sort(
              (a, b) => b.value - a.value,
            );
            if (state.topN) rows = rows.slice(0, state.topN);
            data = { kind: "rows", rows };
            break;
          }
          case "unpaid_invoices": {
            const docs = await openDocs({ type: "ACCREC" });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "overdue_invoices": {
            const docs = await openDocs({ type: "ACCREC", dueBefore: today });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "draft_invoices": {
            const docs = await statusDocs({
              type: "ACCREC",
              statuses: ["DRAFT"],
            });
            data = documentData(docs, state.baseCurrency, "total");
            break;
          }
          case "paid_invoices": {
            const docs = await statusDocs({
              type: "ACCREC",
              statuses: ["PAID"],
            });
            data = documentData(docs, state.baseCurrency, "total");
            break;
          }
          case "voided_invoices": {
            const docs = await statusDocs({
              type: "ACCREC",
              statuses: ["VOIDED"],
            });
            data = documentData(docs, state.baseCurrency, "total");
            break;
          }
          case "unpaid_bills": {
            const docs = await openDocs({ type: "ACCPAY" });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "overdue_bills": {
            const docs = await openDocs({ type: "ACCPAY", dueBefore: today });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "draft_bills": {
            const docs = await statusDocs({
              type: "ACCPAY",
              statuses: ["DRAFT"],
            });
            data = documentData(docs, state.baseCurrency, "total");
            break;
          }
          case "paid_bills": {
            const docs = await statusDocs({
              type: "ACCPAY",
              statuses: ["PAID"],
            });
            data = documentData(docs, state.baseCurrency, "total");
            break;
          }
          case "voided_bills": {
            const docs = await statusDocs({
              type: "ACCPAY",
              statuses: ["VOIDED"],
            });
            data = documentData(docs, state.baseCurrency, "total");
            break;
          }
          case "bills_due_soon": {
            const docs = await openDocs({
              type: "ACCPAY",
              dueAfter: period.from,
              dueBefore: period.to > period.from ? nextDay(period.to) : period.to,
            }, { dateWindow: false });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "receivables": {
            const docs = await openDocs({ type: "ACCREC" });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "payables": {
            const docs = await openDocs({ type: "ACCPAY" });
            data = documentData(docs, state.baseCurrency, "due");
            break;
          }
          case "expenses_by_supplier": {
            // Bill totals in the period, grouped by supplier — never counting the
            // payments as well, which would double-count (XERO-CON-008/EXP-007).
            const bills = await deps.xeroTool.getInvoices(auth, {
              type: "ACCPAY",
              statuses: ["AUTHORISED", "PAID"],
              dateFrom: period.from,
              dateTo: period.to,
            });
            const byContact = new Map<string, number>();
            for (const b of bills) {
              const name = b.Contact?.Name ?? "Unknown";
              byContact.set(name, (byContact.get(name) ?? 0) + (b.Total ?? 0));
            }
            const groups = [...byContact.entries()]
              .map(([label, value]) => ({ label, value }))
              .sort((a, b) => b.value - a.value);
            data = { kind: "grouped", groups };
            break;
          }
          case "invoice_total_for_contact": {
            const contacts = await deps.xeroTool.findContact(
              auth,
              state.contactName ?? "",
            );
            if (!contacts.length) {
              return {
                result: {
                  status: "failed" as const,
                  summary: `No Xero contact matches "${state.contactName}".`,
                },
                _nextNode: REPORT_NODES.finalize,
              };
            }
            const docs = await deps.xeroTool.getInvoices(auth, {
              type: "ACCREC",
              contactId: contacts[0].ContactID,
              statuses: ["AUTHORISED", "PAID"],
              dateFrom: period.from,
              dateTo: period.to,
            });
            const total = docs.reduce((s, d) => s + (d.Total ?? 0), 0);
            data = {
              kind: "grouped",
              groups: [{ label: contacts[0].Name, value: total }],
            };
            break;
          }
          default: {
            // overview
            const totals = await pnlTotals(period.from, period.to);
            const [rec, pay] = await Promise.all([
              openDocs({ type: "ACCREC" }, { dateWindow: false }),
              openDocs({ type: "ACCPAY" }, { dateWindow: false }),
            ]);
            data = {
              kind: "overview",
              revenue: totals.revenue,
              expenses: totals.expenses,
              profit: totals.profit,
              receivables: sumDue(rec),
              payables: sumDue(pay),
            };
          }
        }
        return { reportData: data, _nextNode: REPORT_NODES.composeAnswer };
      } catch (err) {
        deps.logger.error({ err }, "fetch-report-data failed");
        return {
          result: {
            status: "failed" as const,
            summary: `Could not fetch that from Xero: ${err instanceof Error ? err.message : String(err)}`,
          },
          _nextNode: REPORT_NODES.finalize,
        };
      }
    },
  };
}

function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
