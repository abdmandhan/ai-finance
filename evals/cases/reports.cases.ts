import type { EvalCase } from "./types";

const WRITE_OPS = [
  "created",
  "authorised",
  "upserted",
  "createdPayments",
  "deletedPayments",
  "createdCreditNotes",
  "allocations",
  "bankTransactions",
  "bankTransfers",
  "statusUpdates",
] as const;

export const reportCases: EvalCase[] = [
  {
    id: "XERO-EXP-004",
    title: "'how much did we spend this month' answers with period and basis",
    level: "workflow",
    workflow: "report",
    prompt: "How much did we spend this month?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      answerIncludes: [/accrual/i, "3,000"], // stub P&L expenses total
      mustNotOps: [...WRITE_OPS],
    },
  },
  {
    id: "XERO-RPT-002",
    title: "'last month' resolves to the entire previous calendar month",
    level: "workflow",
    workflow: "report",
    prompt: "How much were our expenses last month?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      mustNotOps: [...WRITE_OPS],
    },
  },
  {
    id: "XERO-INV-010",
    title: "'what invoices are unpaid' lists outstanding sales invoices",
    level: "workflow",
    workflow: "report",
    prompt: "What invoices are unpaid?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      answerIncludes: ["INV-200"],
      mustNotOps: [...WRITE_OPS],
    },
  },
  {
    id: "XERO-INV-011",
    title: "'how much do customers owe us' totals receivables",
    level: "workflow",
    workflow: "report",
    prompt: "How much do customers owe us right now?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      answerIncludes: ["1,000"],
      mustNotOps: [...WRITE_OPS],
    },
  },
  {
    id: "XERO-AI-011",
    title: "no period given — defaults to the current month and says so",
    level: "workflow",
    workflow: "report",
    prompt: "How much did we spend?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      answerIncludes: [/current month|no period/i],
      mustNotOps: [...WRITE_OPS],
    },
  },
  {
    id: "XERO-RPT-015",
    title: "'how are we doing' produces a compact overview",
    level: "workflow",
    workflow: "report",
    prompt: "How are we doing?",
    expect: {
      interrupt: "none",
      resultStatus: "answered",
      answerIncludes: [/revenue/i, /expenses/i, /profit/i],
      mustNotOps: [...WRITE_OPS],
    },
  },
  {
    // Regression for DEBUG-5-xero.md: the assistant used to over-clarify
    // ("which system? what counts as spend?") and give up instead of calling
    // financial_report. This asserts it routes straight to the report tool.
    id: "XERO-EXP-004-assistant",
    title: "'how much did we spend this month?' routes to financial_report, no over-clarify",
    level: "assistant",
    prompt: "How much did we spend this month?",
    expect: {
      // Report is read-only — no approval, and no write of any kind.
      interrupt: "none",
      // Proof the model routed to financial_report instead of answering from
      // memory or over-clarifying: the report graph actually queried Xero's P&L.
      ops: { reportRequests: {} },
      mustNotOps: [...WRITE_OPS],
    },
  },
];
