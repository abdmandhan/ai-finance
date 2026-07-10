import { invoiceLineSchema, invoiceResultSchema } from "@/schemas";
import { StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the Xero invoice/bill graph. Serializable so the checkpointer persists it
 * across the clarification and approval interrupts (draft → approve → authorise).
 */
export const InvoiceState = new StateSchema({
  // Inputs
  threadId: z.string(),
  tenantId: z.string().default(""),
  userMessage: z.string(),

  // Extracted entities
  docType: z.enum(["sales", "bill", "unsupported"]).optional(),
  contactName: z.string().nullish(),
  contactId: z.string().nullish(),
  lineItems: z.array(invoiceLineSchema).optional(),
  reference: z.string().nullish(),
  date: z.string().nullish(),
  dueDate: z.string().nullish(),
  currencyCode: z.string().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),

  // Working values
  invoiceId: z.string().nullish(),
  approved: z.boolean().optional(),

  // Output
  result: invoiceResultSchema.optional(),

  // Ephemeral routing signal.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type InvoiceStateType = typeof InvoiceState.State;
