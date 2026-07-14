import { z } from "zod";
import { completedApprovalSchema } from "./completed-approval.schema";

/**
 * A read-only financial question. The LLM only names the metric/period/filters;
 * period math, report fetching, and aggregation are all deterministic code.
 */
export const reportIntentSchema = z.object({
  metric: z.enum([
    "expenses",
    "revenue",
    "profit",
    "balance_sheet",
    "cash",
    "unpaid_invoices",
    "overdue_invoices",
    "draft_invoices",
    "paid_invoices",
    "voided_invoices",
    "unpaid_bills",
    "overdue_bills",
    "draft_bills",
    "paid_bills",
    "voided_bills",
    "bills_due_soon",
    "receivables",
    "payables",
    "top_expenses",
    "expenses_by_supplier",
    "expenses_by_category",
    "invoice_total_for_contact",
    "overview",
    "unsupported",
  ]),
  periodToken: z
    .enum([
      "this_month",
      "last_month",
      "this_quarter",
      "this_year",
      "last_6_months",
      "next_week",
      "custom",
      "none",
    ])
    .describe('Named period the user asked about; "none" when they gave no period.'),
  from: z
    .string()
    .nullable()
    .describe("Custom period start YYYY-MM-DD; only with periodToken=custom."),
  to: z
    .string()
    .nullable()
    .describe("Custom period end YYYY-MM-DD; only with periodToken=custom."),
  compareToPrevious: z
    .boolean()
    .describe("True when the user asks to compare with the previous period."),
  groupBy: z.enum(["none", "contact", "account", "month"]),
  contactName: z
    .string()
    .nullable()
    .describe("Contact to filter by, e.g. for 'how much did we invoice Acme'."),
  minAmount: z
    .number()
    .nullable()
    .describe("Lower bound filter, e.g. 'over Rp10 million'. Null if none."),
  topN: z.number().nullable().describe("For top-N questions, e.g. 5. Null otherwise."),
  clarificationQuestion: z
    .string()
    .nullable()
    .describe("If the question is too ambiguous to answer, the single question to ask."),
});
export type ReportIntent = z.infer<typeof reportIntentSchema>;

export const reportResultSchema = z.object({
  status: z.enum(["answered", "failed"]),
  summary: z.string(),
  period: z
    .object({ from: z.string(), to: z.string(), label: z.string() })
    .optional(),
  /** Accounting basis of the answer. Xero P&L defaults to accrual. */
  basis: z.string().optional(),
  data: z.unknown().optional(),
  completedApproval: completedApprovalSchema.optional(),
});
export type ReportResult = z.infer<typeof reportResultSchema>;

export const reportSchemas = {
  reportIntentSchema,
  reportResultSchema,
};
