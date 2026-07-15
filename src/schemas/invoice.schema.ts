import { z } from "zod";
import { completedApprovalSchema } from "./completed-approval.schema";

/** A single invoice/bill line (tax-exclusive unit amount). */
export const invoiceLineSchema = z.object({
  description: z.string(),
  quantity: z.number().positive().default(1),
  unitAmount: z.number().describe("Unit price, tax-exclusive"),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

export const invoiceActionSchema = z
  .enum([
    "create_invoice",
    "amend_invoice",
    "create_retainer",
    "update_retainer",
    "delete_retainer",
    "list_retainers",
    "unsupported",
  ])
  .default("create_invoice");
export type InvoiceAction = z.infer<typeof invoiceActionSchema>;

export const duePolicySchema = z
  .string()
  .nullable()
  .describe(
    'Due-date policy: "same_as_invoice", "net:N"/"netN", "eom", "eom+N", "cycle:D", or explicit YYYY-MM-DD',
  );
export type DuePolicy = z.infer<typeof duePolicySchema>;

export const retainerStatusSchema = z
  .enum(["active", "paused"])
  .default("active");

export const invoiceRetainerInputSchema = z.object({
  name: z.string().nullable().default(null),
  amount: z.number().positive().nullable().default(null),
  currencyCode: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  frequency: z.string().nullable().default("monthly"),
  billingDay: z.number().int().min(1).max(31).nullable().default(null),
  duePolicy: duePolicySchema.default(null),
  accountCode: z.string().nullable().default(null),
  taxType: z.string().nullable().default(null),
  referenceTemplate: z.string().nullable().default(null),
  startDate: z.string().nullable().default(null),
  endDate: z.string().nullable().default(null),
  status: retainerStatusSchema.default("active"),
  notes: z.string().nullable().default(null),
});
export type InvoiceRetainerInput = z.infer<typeof invoiceRetainerInputSchema>;

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
  action: invoiceActionSchema,
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
  duePolicy: duePolicySchema.default(null),
  currencyCode: z
    .string()
    .nullable()
    .describe("ISO currency, e.g. SGD, if stated"),
  targetInvoiceRef: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "Invoice number/reference to amend, if amending an existing sales invoice",
    ),
  amendmentReason: z.string().nullable().default(null),
  quotedFxRate: z.number().positive().nullable().default(null),
  useRetainer: z
    .boolean()
    .default(false)
    .describe(
      "True only when the user explicitly asks to use a retainer/monthly fee",
    ),
  retainerName: z.string().nullable().default(null),
  retainer: invoiceRetainerInputSchema.nullable().default(null),
  serviceChargeAmount: z
    .number()
    .nullable()
    .describe(
      "Service charge total shown on the document, if any (a separate charge, not tax)",
    ),
  taxRatePercent: z
    .number()
    .nullable()
    .describe("GST/VAT/tax rate percent shown, e.g. 9 for 9%. Null if no tax."),
  taxAmount: z
    .number()
    .nullable()
    .describe(
      "Total tax/GST amount shown on the document, for verification. Null if none.",
    ),
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
  status: z.enum([
    "created",
    "amended",
    "corrected",
    "retainer_saved",
    "retainer_deleted",
    "answered",
    "rejected",
    "failed",
  ]),
  invoiceId: z.string().optional(),
  creditNoteId: z.string().optional(),
  summary: z.string(),
  completedApproval: completedApprovalSchema.optional(),
});
export type InvoiceResult = z.infer<typeof invoiceResultSchema>;

export const invoiceSchemas = {
  invoiceLineSchema,
  invoiceActionSchema,
  duePolicySchema,
  invoiceRetainerInputSchema,
  invoiceIntentSchema,
  invoiceResultSchema,
};
