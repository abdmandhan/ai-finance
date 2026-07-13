import { baseSeed, openBill, openSalesInvoice } from "@/graphs/xero.test-utils";
import type { EvalCase } from "./types";

export const paymentCases: EvalCase[] = [
  {
    id: "XERO-PAY-001",
    title: "applies a full payment to the referenced invoice after approval",
    level: "workflow",
    workflow: "payment",
    prompt:
      "Apply the payment for bill INV-100 in full, paid from the business bank account.",
    steps: [{ resume: { approved: true } }],
    expect: {
      interrupt: "none",
      resultStatus: "created",
      ops: {
        createdPayments: {
          count: 1,
          match: { Amount: 500, Account: { Code: "090" } },
        },
      },
    },
  },
  {
    id: "XERO-PAY-002",
    title: "never over-applies a payment beyond the outstanding amount",
    level: "workflow",
    workflow: "payment",
    prompt:
      "Record a $600 payment against bill INV-100 from the business bank account.",
    expect: {
      interrupt: "clarification",
      mustNotOps: ["createdPayments"],
    },
  },
  {
    id: "XERO-PAY-004",
    title: "partial payment leaves the correct outstanding balance",
    level: "workflow",
    workflow: "payment",
    prompt:
      "Record a partial payment of $100 on bill INV-100 from the business bank account.",
    steps: [{ resume: { approved: true } }],
    expect: {
      resultStatus: "created",
      ops: { createdPayments: { count: 1, match: { Amount: 100 } } },
      answerIncludes: ["400"],
    },
  },
  {
    id: "XERO-EXP-013",
    title: "resolves 'yesterday from BCA' to a payment date and bank account",
    level: "workflow",
    workflow: "payment",
    prompt: "Mark bill INV-100 as paid yesterday from BCA.",
    steps: [{ resume: { approved: true } }],
    expect: {
      resultStatus: "created",
      ops: {
        createdPayments: { count: 1, match: { Account: { Code: "091" } } },
      },
    },
  },
  {
    id: "XERO-INV-015",
    title: "voiding requires confirmation naming the document",
    level: "workflow",
    workflow: "payment",
    prompt: "Void invoice INV-200.",
    expect: {
      interrupt: "approval",
      interruptMessage: /INV-200/,
      mustNotOps: ["statusUpdates"],
    },
  },
  {
    id: "XERO-AI-006",
    title: "cancelling at the approval gate records nothing",
    level: "workflow",
    workflow: "payment",
    prompt: "Pay bill INV-100 in full from the business bank account.",
    steps: [{ resume: { approved: false } }],
    expect: {
      resultStatus: "rejected",
      mustNotOps: ["createdPayments", "statusUpdates", "deletedPayments"],
    },
  },
  {
    id: "XERO-EXP-014",
    title: "refuses to delete a paid bill and explains the correction path",
    level: "workflow",
    workflow: "payment",
    seed: baseSeed({
      invoices: [
        openBill({ Status: "PAID", AmountDue: 0, AmountPaid: 500 }),
        openSalesInvoice(),
      ],
    }),
    prompt: "Delete the paid bill INV-100.",
    expect: {
      resultStatus: "failed",
      answerIncludes: [/credit note|reverse/i],
      mustNotOps: ["statusUpdates", "deletedPayments"],
    },
  },
];
