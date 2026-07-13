import { z } from "zod";
import { invoiceLineSchema } from "./invoice.schema";

/**
 * Entities extracted from a payment/credit/void request against EXISTING Xero
 * documents. Creating new invoices/bills is the invoice workflow, not this one.
 */
export const paymentIntentSchema = z.object({
  action: z.enum([
    "apply_payment",
    "reverse_payment",
    "create_credit_note",
    "refund_credit",
    "void_invoice",
    "unsupported",
  ]),
  targetKind: z
    .enum(["invoice", "bill"])
    .nullable()
    .describe(
      "invoice = customer sales invoice (ACCREC); bill = supplier bill (ACCPAY). Null if unclear.",
    ),
  invoiceRef: z
    .string()
    .nullable()
    .describe("Invoice/bill number referenced, e.g. INV-100. Null if not stated."),
  contactName: z
    .string()
    .nullable()
    .describe("Customer or supplier name if stated. Null otherwise."),
  amount: z
    .number()
    .nullable()
    .describe(
      "Payment/credit amount if stated. Null means the full outstanding amount. Never invent.",
    ),
  date: z
    .string()
    .nullable()
    .describe("Payment date YYYY-MM-DD if stated (resolve 'yesterday' etc). Null otherwise."),
  bankAccountHint: z
    .string()
    .nullable()
    .describe("Bank account named by the user, e.g. 'BCA'. Null if not stated. Never invent."),
  reference: z.string().nullable(),
  creditNoteLines: z
    .array(invoiceLineSchema)
    .nullable()
    .describe("Credit note lines when creating one; null otherwise."),
  allocateToInvoiceRef: z
    .string()
    .nullable()
    .describe("Invoice/bill number a credit note should be applied to, if stated."),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe("If required info is missing, the single question to ask. Else null."),
});
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

export const paymentResultSchema = z.object({
  status: z.enum(["created", "reversed", "voided", "rejected", "failed"]),
  paymentId: z.string().optional(),
  creditNoteId: z.string().optional(),
  invoiceId: z.string().optional(),
  remainingAmountDue: z.number().optional(),
  summary: z.string(),
});
export type PaymentResult = z.infer<typeof paymentResultSchema>;

export const paymentSchemas = {
  paymentIntentSchema,
  paymentResultSchema,
};
