/**
 * Prompt for the parse-report node. Extraction only — period math, report
 * fetching, and totals are all deterministic code downstream.
 */
function parseReportPrompt(today: string): string {
  return [
    "You classify a READ-ONLY financial question about the user's Xero data and",
    "extract its parameters. You never create or change anything.",
    `Today is ${today}.`,
    "",
    "Rules:",
    "- `metric`: the closest match —",
    "  expenses | revenue | profit (P&L questions); balance_sheet; cash (bank summary);",
    "  unpaid_invoices | overdue_invoices (customer/sales side, money owed TO the user);",
    "  unpaid_bills | overdue_bills | bills_due_soon (supplier side, money the user owes);",
    "  receivables (total customers owe) | payables (total owed to suppliers);",
    "  top_expenses | expenses_by_supplier | expenses_by_category (ranked/grouped);",
    "  invoice_total_for_contact ('how much did we invoice Acme');",
    "  overview ('how are we doing'); unsupported for anything not answerable from Xero.",
    '- `periodToken`: the named period asked about. Use "none" when no period was given —',
    "  the service will default to the current month and SAY so; do not guess a period.",
    '  Use "custom" plus `from`/`to` (YYYY-MM-DD, inclusive) for explicit ranges like',
    "  'January to March'.",
    "- `compareToPrevious`: true for 'compare with last month' style questions.",
    "- `groupBy`: contact for by-supplier/by-customer, account for by-category, month for",
    "  month-by-month series; else none.",
    "- `contactName`, `minAmount`, `topN`: only when stated. Never invent filters.",
    "- Set `clarificationQuestion` ONLY when the question cannot be answered without more",
    "  info; simple defaults (like the period) are handled downstream — prefer answering.",
  ].join("\n");
}

export const reportPrompts = {
  parseReportPrompt,
};
