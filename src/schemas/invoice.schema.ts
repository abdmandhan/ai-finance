import { z } from "zod";

/** A single invoice/bill line (tax-exclusive unit amount). */
export const invoiceLineSchema = z.object({
  description: z.string(),
  quantity: z.number().positive().default(1),
  unitAmount: z.number().describe("Unit price, tax-exclusive"),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/**
 * Entities extracted from an invoicing/billing request.
 * `docType`: sales = you invoice a customer (ACCREC); bill = a supplier bills you (ACCPAY).
 * Direction is decided by who owes whom, NOT by the word "invoice".
 */
export const invoiceIntentSchema = z.object({
  docType: z.enum(["sales", "bill", "unsupported"]),
  contactName: z
    .string()
    .nullable()
    .describe("Customer (sales) or supplier (bill) name"),
  lineItems: z
    .array(invoiceLineSchema)
    .describe("At least one line; empty if unknown"),
  reference: z.string().nullable(),
  date: z.string().nullable().describe("Invoice date YYYY-MM-DD if stated"),
  dueDate: z.string().nullable().describe("Due date YYYY-MM-DD if stated"),
  currencyCode: z
    .string()
    .nullable()
    .describe("ISO currency, e.g. SGD, if stated"),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe(
      "If required info (contact or line items) is missing, the single question to ask",
    ),
});
export type InvoiceIntent = z.infer<typeof invoiceIntentSchema>;

export const invoiceResultSchema = z.object({
  status: z.enum(["created", "rejected", "failed"]),
  invoiceId: z.string().optional(),
  summary: z.string(),
});
export type InvoiceResult = z.infer<typeof invoiceResultSchema>;

export const invoiceSchemas = {
  invoiceLineSchema,
  invoiceIntentSchema,
  invoiceResultSchema,
};
