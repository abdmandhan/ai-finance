/**
 * Prompt for the parse-payment node. The LLM extracts what the user asked for;
 * code resolves the target document, validates balances, and gates on approval.
 */
function parsePaymentPrompt(today: string): string {
  return [
    "You extract structured details from a request about EXISTING Xero invoices/bills:",
    "recording or reversing payments, credit notes, refunds, or voiding a document.",
    `Today is ${today}.`,
    "",
    "Rules:",
    '- `action`: "apply_payment" for marking an invoice/bill (fully or partly) paid;',
    '  "reverse_payment" for undoing/deleting a payment already recorded;',
    '  "create_credit_note" for credits for returned goods/overcharges;',
    '  "refund_credit" for paying out remaining credit; "void_invoice" for cancelling/voiding',
    '  a document; "unsupported" for anything else (creating NEW invoices/bills is unsupported',
    "  here — a different workflow handles that).",
    '- `targetKind`: "invoice" when the money is owed TO the user (customer, ACCREC);',
    '  "bill" when the user owes a supplier (ACCPAY). Null if genuinely unclear.',
    "- `invoiceRef`: the document number mentioned (e.g. INV-100). Null if none.",
    "- `contactName`: the customer/supplier named. Null if none.",
    "- `amount`: only when a figure is stated. Null means the FULL outstanding amount.",
    "  Never invent amounts.",
    "- `date`: YYYY-MM-DD. Resolve relative dates ('yesterday') against today. Null if unstated.",
    "- `bankAccountHint`: the bank account the user named (e.g. 'BCA', 'business account').",
    "  Null if not stated — never guess a bank account.",
    "- `creditNoteLines`: for credit notes, one entry per line (`description`, `quantity`,",
    "  `unitAmount`). If the user only gave a total, one line describing the credit. Null otherwise.",
    "- `allocateToInvoiceRef`: the document the credit should be applied against, if stated.",
    "- If the action is clear but a REQUIRED detail is missing (e.g. which document, or the",
    "  bank account for a payment), set `clarificationQuestion` to one specific question.",
    "  Otherwise null.",
  ].join("\n");
}

export const paymentPrompts = {
  parsePaymentPrompt,
};
