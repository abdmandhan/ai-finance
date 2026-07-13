import type { ReportStateType } from "@/graphs/report.state";
import type { ReportData } from "./fetch-report-data";
import { REPORT_NODES, type ReportDeps } from "./shared";

/**
 * Deterministic answer composition — the assistant graph rephrases tool results
 * conversationally, so no LLM here. Always states the period (and that it was
 * defaulted, when it was) and the accounting basis for P&L-derived numbers.
 */
export function makeComposeReportAnswerNode(deps: ReportDeps) {
  return {
    name: REPORT_NODES.composeAnswer,
    node: async (state: ReportStateType) => {
      const data = state.reportData as ReportData;
      const period = state.period!;
      const cur = state.baseCurrency ? `${state.baseCurrency} ` : "";
      const fmt = (n: number | undefined) =>
        n === undefined ? "n/a" : `${cur}${n.toLocaleString("en-US")}`;
      const periodNote = period.defaulted
        ? `${period.label} (no period was given, so I used the current month)`
        : period.label;

      const lines: string[] = [];
      let basis: string | undefined;

      switch (data.kind) {
        case "totals": {
          basis = "accrual";
          if (state.metric === "expenses")
            lines.push(`Expenses for ${periodNote}: ${fmt(data.expenses)} (accrual basis).`);
          else if (state.metric === "revenue")
            lines.push(`Revenue for ${periodNote}: ${fmt(data.revenue)} (accrual basis, excluding tax collected).`);
          else
            lines.push(
              `Profit for ${periodNote}: ${fmt(data.profit)} (revenue ${fmt(data.revenue)} − expenses ${fmt(data.expenses)}, accrual basis).`,
            );
          if (data.prev) {
            const cursor =
              state.metric === "revenue"
                ? [data.revenue, data.prev.revenue]
                : state.metric === "profit"
                  ? [data.profit, data.prev.profit]
                  : [data.expenses, data.prev.expenses];
            const [nowV, prevV] = cursor;
            if (nowV !== undefined && prevV !== undefined) {
              const delta = nowV - prevV;
              const pct = prevV !== 0 ? ((delta / prevV) * 100).toFixed(1) : "n/a";
              lines.push(
                `Compared with ${data.prev.label}: ${fmt(prevV)} → ${fmt(nowV)} (${delta >= 0 ? "+" : ""}${fmt(delta)}, ${pct}%).`,
              );
            }
          }
          break;
        }
        case "balance_sheet":
          lines.push(
            `Balance sheet as of ${period.to}: assets ${fmt(data.assets)}, liabilities ${fmt(data.liabilities)}, equity ${fmt(data.equity)}.`,
          );
          break;
        case "rows": {
          const title =
            state.metric === "cash"
              ? `Bank summary for ${periodNote}`
              : `Expense categories for ${periodNote} (accrual basis)`;
          basis = state.metric === "cash" ? undefined : "accrual";
          lines.push(`${title}:`);
          for (const r of data.rows) lines.push(`- ${r.label}: ${fmt(r.value)}`);
          if (!data.rows.length) lines.push("(no data)");
          break;
        }
        case "documents": {
          const noun =
            {
              unpaid_invoices: "unpaid customer invoices",
              overdue_invoices: "overdue customer invoices",
              unpaid_bills: "unpaid bills",
              overdue_bills: "overdue bills",
              bills_due_soon: `bills due ${period.label}`,
              receivables: "outstanding customer invoices (receivables)",
              payables: "outstanding bills (payables)",
            }[state.metric ?? ""] ?? "documents";
          const filterNote =
            state.minAmount != null ? ` over ${fmt(state.minAmount)}` : "";
          lines.push(
            `${data.count} ${noun}${filterNote}, totalling ${fmt(data.total)} outstanding:`,
          );
          for (const d of data.docs.slice(0, 15))
            lines.push(
              `- ${d.number ?? "?"} ${d.contact ?? ""}: ${fmt(d.amountDue)} due${d.dueDate ? ` (due ${d.dueDate})` : ""}`,
            );
          if (data.docs.length > 15)
            lines.push(`…and ${data.docs.length - 15} more.`);
          if (!data.count) lines[0] = `No ${noun}${filterNote} found. 🎉`;
          break;
        }
        case "grouped": {
          lines.push(
            state.metric === "invoice_total_for_contact"
              ? `Invoiced ${data.groups[0]?.label ?? ""} ${fmt(data.groups[0]?.value ?? 0)} in ${periodNote} (approved + paid sales invoices).`
              : `By supplier for ${periodNote} (bill totals — payments not double-counted):`,
          );
          if (state.metric !== "invoice_total_for_contact")
            for (const g of data.groups)
              lines.push(`- ${g.label}: ${fmt(g.value)}`);
          break;
        }
        case "overview":
          basis = "accrual";
          lines.push(
            `Overview for ${periodNote} (accrual basis):`,
            `- Revenue: ${fmt(data.revenue)}`,
            `- Expenses: ${fmt(data.expenses)}`,
            `- Profit: ${fmt(data.profit)}`,
            `- Customers owe you (receivables): ${fmt(data.receivables)}`,
            `- You owe suppliers (payables): ${fmt(data.payables)}`,
          );
          break;
      }

      deps.logger.info({ metric: state.metric }, "report answer composed");
      return {
        result: {
          status: "answered" as const,
          summary: lines.join("\n"),
          period: { from: period.from, to: period.to, label: period.label },
          ...(basis ? { basis } : {}),
          data,
        },
        _nextNode: REPORT_NODES.finalize,
      };
    },
  };
}
