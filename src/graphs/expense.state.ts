import {
  attachmentRefSchema,
  expenseResultSchema,
  invoiceLineSchema,
} from "@/schemas";
import { StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the Xero expense graph (spend/receive money + bank transfers).
 * These writes are immediately effective — approval happens BEFORE creation.
 */
export const ExpenseState = new StateSchema({
  // Inputs
  threadId: z.string(),
  tenantId: z.string().default(""),
  userMessage: z.string(),
  attachments: z.array(attachmentRefSchema).default(() => []),

  // Extracted intent
  kind: z.enum(["spend", "receive", "transfer", "unsupported"]).optional(),
  contactName: z.string().nullish(),
  lineItems: z.array(invoiceLineSchema).optional(),
  amount: z.number().nullish(),
  currencyCode: z.string().nullish(),
  date: z.string().nullish(),
  reference: z.string().nullish(),
  bankAccountHint: z.string().nullish(),
  fromAccountHint: z.string().nullish(),
  toAccountHint: z.string().nullish(),
  taxRatePercent: z.number().nullish(),
  taxAmount: z.number().nullish(),
  amountsAreTaxInclusive: z.boolean().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),

  // Resolved working values
  resolvedBankAccount: z
    .object({ code: z.string(), name: z.string().optional() })
    .nullish(),
  resolvedFromAccount: z
    .object({ code: z.string(), name: z.string().optional() })
    .nullish(),
  resolvedToAccount: z
    .object({ code: z.string(), name: z.string().optional() })
    .nullish(),
  resolvedContactId: z.string().nullish(),
  resolvedDate: z.string().nullish(),
  bankTransactionId: z.string().nullish(),
  approved: z.boolean().optional(),

  // Output
  result: expenseResultSchema.optional(),

  // Ephemeral routing signal.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type ExpenseStateType = typeof ExpenseState.State;
