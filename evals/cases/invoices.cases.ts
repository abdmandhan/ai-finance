import type { EvalCase } from "./types";

const AWS_INVOICE_TEXT = [
  "--- document (uploaded supplier invoice) ---",
  "AMAZON WEB SERVICES",
  "Invoice number: INV-2026-0311",
  "Invoice date: 2026-03-31   Due date: 2026-04-30",
  "Cloud services (March 2026)  1 x 100.00 USD",
  "Subtotal: 100.00  Tax (11%): 11.00  TOTAL: 111.00 USD",
].join("\n");

export const invoiceCases: EvalCase[] = [
  {
    id: "XERO-DOC-001",
    title: "a supplier invoice becomes an ACCPAY bill with extracted fields",
    level: "workflow",
    workflow: "invoice",
    prompt: `Create a bill from this receipt.\n\n${AWS_INVOICE_TEXT}`,
    expect: {
      interrupt: "approval",
      ops: {
        created: {
          count: 1,
          match: { Type: "ACCPAY", Status: "DRAFT" },
        },
        upserted: { count: 1 }, // AWS is not in the seed — one contact created
      },
      // The one thing that must never happen: a sales invoice from a supplier doc.
      mustNotOps: ["authorised"],
    },
  },
  {
    id: "XERO-INV-001",
    title: "10 consulting hours at $100 → a $1,000 ACCREC draft",
    level: "workflow",
    workflow: "invoice",
    prompt: "Create an invoice for Acme Ltd for 10 consulting hours at $100 per hour.",
    expect: {
      interrupt: "approval",
      ops: { created: { count: 1, match: { Type: "ACCREC" } } },
      mustNotOps: ["authorised", "upserted"], // Acme Ltd exists in the seed
    },
  },
  {
    id: "XERO-INV-004",
    title: "'draft only' — rejecting the approval leaves the draft unauthorised",
    level: "workflow",
    workflow: "invoice",
    prompt: "Create a draft invoice for Acme Ltd: 2 workshops at $250 each. Draft only.",
    steps: [{ resume: { approved: false } }],
    expect: {
      resultStatus: "rejected",
      ops: { created: { count: 1 } },
      mustNotOps: ["authorised"],
    },
  },
  {
    id: "XERO-AI-001",
    title: "'create an invoice' with no details asks for the missing information",
    level: "workflow",
    workflow: "invoice",
    prompt: "Create an invoice.",
    expect: {
      interrupt: "clarification",
      mustNotOps: ["created", "upserted"],
    },
  },
  {
    id: "XERO-AI-010",
    title: "user says 'invoice' but the document is a supplier bill",
    level: "workflow",
    workflow: "invoice",
    prompt: [
      "Add this invoice to Xero.",
      "",
      "--- document (uploaded) ---",
      "STATIONERY CO — INVOICE #S-441 issued to YOUR COMPANY",
      "Office supplies  1 x 150.00",
      "TOTAL DUE BY YOU: 150.00",
    ].join("\n"),
    expect: {
      interrupt: "approval",
      ops: { created: { count: 1, match: { Type: "ACCPAY" } } },
    },
  },
  {
    id: "XERO-DOC-014",
    title: "cropped document without a total — asks, never invents",
    level: "workflow",
    workflow: "invoice",
    prompt: [
      "Create a bill from this receipt.",
      "",
      "--- document (uploaded, bottom half cut off) ---",
      "MEGA MART",
      "[...the item lines and total are cut off and unreadable...]",
    ].join("\n"),
    expect: {
      interrupt: "clarification",
      mustNotOps: ["created"],
    },
  },
  {
    id: "XERO-DOC-017",
    title: "tax-inclusive receipt posts as Inclusive — tax not added twice",
    level: "workflow",
    workflow: "invoice",
    prompt: [
      "Record this bill.",
      "",
      "--- document (uploaded receipt) ---",
      "FOOD COURT PTE LTD",
      "Meal  1 x 109.00",
      "TOTAL: 109.00 (price inclusive of 9% GST: 9.00)",
    ].join("\n"),
    expect: {
      interrupt: "approval",
      ops: {
        created: { count: 1, match: { LineAmountTypes: "Inclusive" } },
      },
    },
  },
];
