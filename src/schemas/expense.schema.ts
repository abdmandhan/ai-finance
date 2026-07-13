import { z } from "zod";
import { invoiceLineSchema } from "./invoice.schema";

/**
 * Entities extracted from a direct money-movement request: spend money (paid
 * expense), receive money, or a transfer between bank accounts. Supplier bills
 * with a due date belong to the invoice workflow, not here.
 */
export const expenseIntentSchema = z.object({
  kind: z.enum(["spend", "receive", "transfer", "unsupported"]),
  contactName: z
    .string()
    .nullable()
    .describe("Payee (spend) or payer (receive) name if stated. Null otherwise."),
  lineItems: z
    .array(invoiceLineSchema)
    .describe("One entry per line; empty if only a total is stated."),
  amount: z
    .number()
    .nullable()
    .describe("The total amount when no line items are given. Never invent."),
  currencyCode: z.string().nullable().describe("ISO currency if stated."),
  date: z
    .string()
    .nullable()
    .describe("Transaction date YYYY-MM-DD if stated (resolve relative dates). Null otherwise."),
  reference: z.string().nullable(),
  bankAccountHint: z
    .string()
    .nullable()
    .describe("Bank account named for a spend/receive, e.g. 'business account'. Never invent."),
  fromAccountHint: z
    .string()
    .nullable()
    .describe("Source bank account for a transfer. Null unless a transfer."),
  toAccountHint: z
    .string()
    .nullable()
    .describe("Destination bank account for a transfer. Null unless a transfer."),
  taxRatePercent: z
    .number()
    .nullable()
    .describe("GST/VAT rate percent shown on a receipt, e.g. 9. Null if none."),
  taxAmount: z
    .number()
    .nullable()
    .describe("Tax total shown on the receipt, for verification. Null if none."),
  amountsAreTaxInclusive: z
    .boolean()
    .describe("True if prices already include the tax. Default false when unsure."),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe("If required info is missing, the single question to ask. Else null."),
});
export type ExpenseIntent = z.infer<typeof expenseIntentSchema>;

export const expenseResultSchema = z.object({
  status: z.enum(["created", "rejected", "failed"]),
  bankTransactionId: z.string().optional(),
  transferId: z.string().optional(),
  summary: z.string(),
});
export type ExpenseResult = z.infer<typeof expenseResultSchema>;

export const expenseSchemas = {
  expenseIntentSchema,
  expenseResultSchema,
};
