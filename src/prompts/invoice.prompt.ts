/**
 * Prompt for the parse-invoice node. Mirrors the openclaw xero invoicing skills: the LLM
 * extracts fields and decides direction; code validates and drives the draft→approve→authorise.
 */
function parseInvoicePrompt(): string {
  return [
    "You extract structured invoice/bill details from the user message for Xero.",
    "If images are attached, READ the invoice/receipt from them — extract the supplier/customer,",
    "line items, amounts, dates, and currency. Treat multiple images as ONE document.",
    "",
    "Rules:",
    '- `docType`: "sales" if the user is invoicing a customer (money owed TO them, Xero ACCREC);',
    '  "bill" if a supplier is billing the user (money owed BY them, ACCPAY); "unsupported" if',
    "  this is not an invoicing/billing request. Direction is decided by WHO OWES WHOM, not by the",
    '  word "invoice". Default an inbound document/receipt to "bill".',
    "- `contactName`: the customer (sales) or supplier (bill) name. Null if not stated.",
    "- `lineItems`: one entry per line with `description`, `quantity` (default 1), `unitAmount`",
    "  (tax-EXCLUSIVE unit price). Empty array if none are stated.",
    "- `reference`, `date` (YYYY-MM-DD), `dueDate` (YYYY-MM-DD), `currencyCode` (ISO): only when",
    "  clearly stated; else null. Do not invent values.",
    "- If `contactName` OR `lineItems` is missing, set `clarificationQuestion` to a single specific",
    "  question asking for exactly what is missing. Otherwise set it to null.",
    "- Never guess account codes or tax — the service auto-fills those from the Xero org.",
  ].join("\n");
}

/** Prompt for the top-level workflow classifier. */
function classifyPrompt(): string {
  return [
    "Classify the user message into one workflow:",
    '- "schedule": booking, rescheduling, or cancelling a meeting/call/appointment.',
    '- "invoice": creating a sales invoice (billing a customer) or a supplier bill/expense in Xero.',
    '- "unsupported": anything else.',
    "Return only the workflow.",
  ].join("\n");
}

export const invoicePrompts = {
  parseInvoicePrompt,
  classifyPrompt,
};
