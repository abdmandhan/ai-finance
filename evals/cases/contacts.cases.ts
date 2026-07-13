import type { EvalCase } from "./types";

export const contactCases: EvalCase[] = [
  {
    id: "XERO-CON-003",
    title: "'ACME LIMITED' resolves to the existing 'Acme Ltd' — no duplicate contact",
    level: "workflow",
    workflow: "invoice",
    prompt: "Invoice ACME for 3 support hours at $80 each.",
    expect: {
      interrupt: "approval",
      ops: { created: { count: 1, match: { Type: "ACCREC" } } },
      mustNotOps: ["upserted"],
    },
  },
  {
    id: "XERO-CON-002",
    title: "an unknown supplier from a document creates exactly one contact",
    level: "workflow",
    workflow: "invoice",
    prompt: [
      "Create a bill from this invoice.",
      "",
      "--- document (uploaded) ---",
      "STATIONERY WORLD PTE LTD — INVOICE #SW-9",
      "Paper  10 x 5.00   TOTAL: 50.00",
    ].join("\n"),
    expect: {
      interrupt: "approval",
      ops: { upserted: { count: 1 }, created: { count: 1 } },
    },
  },
  {
    id: "XERO-CON-006",
    title: "'how much did we invoice Acme this year' aggregates that contact's invoices",
    level: "workflow",
    workflow: "report",
    prompt: "How much did we invoice Acme this year?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      answerIncludes: ["Acme"],
      mustNotOps: ["created", "upserted"],
    },
  },
];
