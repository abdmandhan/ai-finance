import type { EvalCase } from "./types";

export const expenseCases: EvalCase[] = [
  {
    id: "XERO-EXP-002",
    title: "parking paid from the bank account → SPEND money transaction",
    level: "workflow",
    workflow: "expense",
    prompt: "Record $20 for parking, paid from the business bank account.",
    steps: [{ resume: { approved: true } }],
    expect: {
      resultStatus: "created",
      ops: {
        bankTransactions: {
          count: 1,
          match: { Type: "SPEND", BankAccount: { Code: "090" } },
        },
      },
      mustNotOps: ["created"], // never an invoice/bill
    },
  },
  {
    id: "XERO-BANK-003",
    title: "transfer between two distinct bank accounts",
    level: "workflow",
    workflow: "expense",
    prompt: "Transfer $1,000 from the business bank account to BCA checking.",
    steps: [{ resume: { approved: true } }],
    expect: {
      resultStatus: "created",
      ops: {
        bankTransfers: {
          count: 1,
          match: {
            FromBankAccount: { Code: "090" },
            ToBankAccount: { Code: "091" },
            Amount: 1000,
          },
        },
      },
    },
  },
  {
    id: "XERO-BANK-004",
    title: "identical source and destination — transfer rejected",
    level: "workflow",
    workflow: "expense",
    prompt:
      "Transfer $500 from the business bank account to the business bank account.",
    expect: {
      resultStatus: "failed",
      mustNotOps: ["bankTransfers", "bankTransactions"],
    },
  },
  {
    id: "XERO-DOC-003",
    title: "a paid retail receipt is recorded as spend money, not a sales invoice",
    level: "workflow",
    workflow: "expense",
    prompt: [
      "Record this expense from the business bank account.",
      "",
      "--- document (uploaded receipt) ---",
      "GRAB TRANSPORT — PAID",
      "Trip: airport to office  1 x 35.00",
      "TOTAL PAID: 35.00",
    ].join("\n"),
    steps: [{ resume: { approved: true } }],
    expect: {
      resultStatus: "created",
      ops: { bankTransactions: { count: 1, match: { Type: "SPEND" } } },
      mustNotOps: ["created"],
    },
  },
  {
    id: "XERO-BANK-002",
    title: "money received from a customer with open invoices asks payment-vs-receive",
    level: "workflow",
    workflow: "expense",
    prompt:
      "Record $2,000 received from Acme Ltd into the business bank account.",
    expect: {
      interrupt: "clarification",
      interruptMessage: /INV-200|invoice/i,
      mustNotOps: ["bankTransactions", "createdPayments"],
    },
  },
];
