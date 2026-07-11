import { z } from "zod";

/** A single invoice/bill line (tax-exclusive unit amount). */
export const invoiceLineSchema = z.object({
  description: z.string(),
  quantity: z.number().positive().default(1),
  unitAmount: z.number().describe("Unit price, tax-exclusive"),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/** A file attached to the inbound message (photo/document) to read and attach to the draft. */
export const attachmentRefSchema = z.object({
  url: z.string(),
  mimeType: z.string(),
  fileName: z.string(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

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
  serviceChargeAmount: z
    .number()
    .nullable()
    .describe("Service charge total shown on the document, if any (a separate charge, not tax)"),
  taxRatePercent: z
    .number()
    .nullable()
    .describe("GST/VAT/tax rate percent shown, e.g. 9 for 9%. Null if no tax."),
  taxAmount: z
    .number()
    .nullable()
    .describe("Total tax/GST amount shown on the document, for verification. Null if none."),
  amountsAreTaxInclusive: z
    .boolean()
    .describe(
      "True if the line prices already INCLUDE the tax (receipt says 'incl. GST', or total = sum of lines). False if a subtotal + separate tax line is shown.",
    ),
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
