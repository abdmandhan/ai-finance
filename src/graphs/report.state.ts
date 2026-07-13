import { reportResultSchema } from "@/schemas";
import { StateSchema, UntrackedValue } from "@langchain/langgraph";
import { z } from "zod";

/**
 * State for the read-only report graph. This graph has NO approval node by
 * construction — it can only ask clarifying questions, never write to Xero.
 */
export const ReportState = new StateSchema({
  // Inputs
  threadId: z.string(),
  tenantId: z.string().default(""),
  userMessage: z.string(),

  // Extracted intent
  metric: z.string().optional(),
  periodToken: z.string().nullish(),
  customFrom: z.string().nullish(),
  customTo: z.string().nullish(),
  compareToPrevious: z.boolean().nullish(),
  groupBy: z.string().nullish(),
  contactName: z.string().nullish(),
  minAmount: z.number().nullish(),
  topN: z.number().nullish(),
  clarificationQuestion: z.string().nullish(),
  clarifyAttempts: z.number().default(0),

  // Resolved working values
  period: z
    .object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      defaulted: z.boolean().optional(),
    })
    .nullish(),
  timezone: z.string().nullish(),
  baseCurrency: z.string().nullish(),
  reportData: z.unknown().nullish(),

  // Output
  result: reportResultSchema.optional(),

  // Ephemeral routing signal.
  _nextNode: new UntrackedValue(z.string().optional()),
});

export type ReportStateType = typeof ReportState.State;
