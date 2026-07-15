import {
  attachmentRefSchema,
  chatContentSchema,
  invoiceActionSchema,
  invoiceLineSchema,
  invoiceRetainerInputSchema,
  invoiceResultSchema,
} from "@/schemas";
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
  attachments: z.array(attachmentRefSchema).default(() => []),

  // Extracted entities
  action: invoiceActionSchema.default("create_invoice"),
  docType: z.enum(["sales", "bill", "unsupported"]).optional(),
  contactName: z.string().nullish(),
  contactId: z.string().nullish(),
  lineItems: z.array(invoiceLineSchema).optional(),
  reference: z.string().nullish(),
  date: z.string().nullish(),
  dueDate: z.string().nullish(),
  duePolicy: z.string().nullish(),
  currencyCode: z.string().nullish(),
  targetInvoiceRef: z.string().nullish(),
  fileName: z.string().nullish(),
  amendmentReason: z.string().nullish(),
  quotedFxRate: z.number().nullish(),
  useRetainer: z.boolean().default(false),
  retainerName: z.string().nullish(),
  retainer: invoiceRetainerInputSchema.nullish(),
  serviceChargeAmount: z.number().nullish(),
  taxRatePercent: z.number().nullish(),
  taxAmount: z.number().nullish(),
  amountsAreTaxInclusive: z.boolean().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),

  // Working values
  invoiceId: z.string().nullish(),
  originalInvoice: z.unknown().optional(),
  amendmentInvoice: z.unknown().optional(),
  amendmentPreview: z.string().nullish(),
  amendmentMode: z.enum(["update", "correction"]).nullish(),
  creditNoteId: z.string().nullish(),
  customer: z.unknown().optional(),
  customerArBalance: z.number().nullish(),
  fxRate: z.number().nullish(),
  fxWarning: z.string().nullish(),
  duplicateCandidate: z.unknown().optional(),
  approved: z.boolean().optional(),
  pendingPdfRequest: z.boolean().default(false),
  pdfDocument: chatContentSchema.optional(),
  pdfError: z.string().nullish(),

  // Output
  result: invoiceResultSchema.optional(),

  // Ephemeral routing signal.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type InvoiceStateType = typeof InvoiceState.State;
