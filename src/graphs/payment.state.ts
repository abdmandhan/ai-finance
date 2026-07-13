import { invoiceLineSchema, paymentResultSchema } from "@/schemas";
import { StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the Xero payment graph (payments / credit notes / reversals / voids
 * against EXISTING documents). Serializable so the checkpointer persists it across
 * the clarification and approval interrupts. Unlike invoices there is no safe DRAFT
 * stage — every write is immediately effective, so approval happens BEFORE the write.
 */
export const PaymentState = new StateSchema({
  // Inputs
  threadId: z.string(),
  tenantId: z.string().default(""),
  userMessage: z.string(),

  // Extracted intent
  action: z
    .enum([
      "apply_payment",
      "reverse_payment",
      "create_credit_note",
      "refund_credit",
      "void_invoice",
      "unsupported",
    ])
    .optional(),
  targetKind: z.enum(["invoice", "bill"]).nullish(),
  invoiceRef: z.string().nullish(),
  contactName: z.string().nullish(),
  amount: z.number().nullish(),
  date: z.string().nullish(),
  bankAccountHint: z.string().nullish(),
  reference: z.string().nullish(),
  creditNoteLines: z.array(invoiceLineSchema).nullish(),
  allocateToInvoiceRef: z.string().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),

  // Resolved working values (deterministic, from Xero lookups)
  resolvedInvoice: z
    .object({
      id: z.string(),
      number: z.string().optional(),
      type: z.string().optional(),
      status: z.string().optional(),
      amountDue: z.number().optional(),
      contactName: z.string().optional(),
    })
    .nullish(),
  resolvedAllocationInvoice: z
    .object({
      id: z.string(),
      number: z.string().optional(),
      amountDue: z.number().optional(),
    })
    .nullish(),
  resolvedPaymentId: z.string().nullish(),
  resolvedBankAccount: z
    .object({ code: z.string(), name: z.string().optional() })
    .nullish(),
  resolvedContactId: z.string().nullish(),
  resolvedAmount: z.number().nullish(),
  resolvedDate: z.string().nullish(),
  approved: z.boolean().optional(),

  // Output
  result: paymentResultSchema.optional(),

  // Ephemeral routing signal.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type PaymentStateType = typeof PaymentState.State;
