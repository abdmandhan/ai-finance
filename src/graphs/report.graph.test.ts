import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { MemorySaver } from "@langchain/langgraph";
import type { ReportIntent } from "@/schemas";
import type { ILlmService, XeroAuth } from "@/services";
import {
  StubXeroTool,
  type StubXeroSeed,
  type XeroInvoiceDetail,
} from "@/tools";
import type { ReportDeps } from "@/nodes";
import { buildReportGraph } from "./report.graph";

// Sunday 2026-07-12 in Asia/Singapore (the stub org's timezone).
const NOW = () => new Date("2026-07-12T10:00:00Z");

function intent(over: Partial<ReportIntent> = {}): ReportIntent {
  return {
    metric: "expenses",
    periodToken: "this_month",
    from: null,
    to: null,
    compareToPrevious: false,
    groupBy: "none",
    contactName: null,
    minAmount: null,
    topN: null,
    clarificationQuestion: null,
    ...over,
  };
}

const fakeAuth: XeroAuth = {
  accessToken: "x",
  xeroTenantId: "t",
  apiBaseUrl: "https://api.xero.com/api.xro/2.0",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

const INVOICES: XeroInvoiceDetail[] = [
  {
    InvoiceID: "i-1",
    InvoiceNumber: "INV-1",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: { ContactID: "c-acme", Name: "Acme" },
    Date: "2026-06-01",
    DueDate: "2026-06-30", // overdue
    Total: 1000,
    AmountDue: 1000,
  },
  {
    InvoiceID: "i-2",
    InvoiceNumber: "INV-2",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: { ContactID: "c-beta", Name: "Beta Ltd" },
    Date: "2026-07-01",
    DueDate: "2026-08-01", // not yet due
    Total: 12_000_000,
    AmountDue: 12_000_000,
  },
  {
    InvoiceID: "i-3",
    InvoiceNumber: "INV-3",
    Type: "ACCREC",
    Status: "PAID",
    Contact: { ContactID: "c-acme", Name: "Acme" },
    Date: "2026-05-01",
    DueDate: "2026-05-31", // past due but PAID — must never count
    Total: 500,
    AmountDue: 0,
  },
  {
    InvoiceID: "b-1",
    InvoiceNumber: "BILL-1",
    Type: "ACCPAY",
    Status: "AUTHORISED",
    Contact: { ContactID: "c-sup", Name: "Supplier Co" },
    Date: "2026-06-20",
    DueDate: "2026-07-15", // due next week
    Total: 300,
    AmountDue: 300,
  },
  {
    InvoiceID: "b-2",
    InvoiceNumber: "BILL-2",
    Type: "ACCPAY",
    Status: "VOIDED",
    Contact: { ContactID: "c-sup", Name: "Supplier Co" },
    Date: "2026-06-01",
    DueDate: "2026-06-15",
    Total: 999,
    AmountDue: 0,
  },
];

function buildGraph(
  opts: { intents?: ReportIntent[]; seed?: StubXeroSeed } = {},
) {
  const logger = pino({ level: "silent" });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { invoke: vi.fn(), extract, chat: vi.fn() };
  const xeroTool = new StubXeroTool(
    opts.seed ?? {
      contacts: [
        { ContactID: "c-acme", Name: "Acme" },
        { ContactID: "c-beta", Name: "Beta Ltd" },
      ],
      invoices: INVOICES.map((i) => ({ ...i })),
    },
  );
  const deps: ReportDeps = {
    llmService,
    xeroTool,
    resolveXeroAuth: async () => fakeAuth,
    logger,
    now: NOW,
  };
  return { graph: buildReportGraph(deps, new MemorySaver()), xeroTool };
}

function config(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

function expectNoWrites(xeroTool: StubXeroTool) {
  expect(xeroTool.created).toHaveLength(0);
  expect(xeroTool.createdPayments).toHaveLength(0);
  expect(xeroTool.createdCreditNotes).toHaveLength(0);
  expect(xeroTool.bankTransactions).toHaveLength(0);
  expect(xeroTool.bankTransfers).toHaveLength(0);
  expect(xeroTool.statusUpdates).toHaveLength(0);
  expect(xeroTool.upserted).toHaveLength(0);
}

describe("report graph — P&L questions", () => {
  it("XERO-RPT-001: 'expenses this month' uses the full current calendar month and states the basis", async () => {
    const { graph, xeroTool } = buildGraph();
    const done: any = await graph.invoke(
      { threadId: "rpt-1", tenantId: "t1", userMessage: "How much were our expenses this month?" },
      config("rpt-1"),
    );
    expect(done.result.status).toBe("answered");
    expect(done.result.period).toMatchObject({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(done.result.basis).toBe("accrual");
    expect(done.result.summary).toContain("accrual");
    expect(xeroTool.reportRequests).toEqual([
      {
        name: "ProfitAndLoss",
        params: { fromDate: "2026-07-01", toDate: "2026-07-31" },
      },
    ]);
  });

  it("XERO-RPT-002: 'last month' uses the entire previous calendar month", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ periodToken: "last_month" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-2", tenantId: "t1", userMessage: "expenses last month?" },
      config("rpt-2"),
    );
    expect(done.result.period).toMatchObject({
      from: "2026-06-01",
      to: "2026-06-30",
    });
    expect(xeroTool.reportRequests[0].params).toEqual({
      fromDate: "2026-06-01",
      toDate: "2026-06-30",
    });
  });

  it("XERO-AI-011: no period → defaults to this month AND says so", async () => {
    const { graph } = buildGraph({
      intents: [intent({ periodToken: "none" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-none", tenantId: "t1", userMessage: "How much did we spend?" },
      config("rpt-none"),
    );
    expect(done.result.status).toBe("answered");
    expect(done.result.period).toMatchObject({ from: "2026-07-01" });
    expect(done.result.summary).toContain("no period was given");
  });

  it("XERO-EXP-006: compare with last month fetches both equivalent periods and shows the delta", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ compareToPrevious: true })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-cmp", tenantId: "t1", userMessage: "compare this month's expenses with last month" },
      config("rpt-cmp"),
    );
    expect(done.result.status).toBe("answered");
    expect(xeroTool.reportRequests.map((r) => r.params.fromDate)).toEqual([
      "2026-07-01",
      "2026-06-01",
    ]);
    expect(done.result.summary).toContain("Compared with June 2026");
    expect(done.result.summary).toContain("%");
  });

  it("XERO-RPT-003: profit states range, formula, and basis", async () => {
    const { graph } = buildGraph({ intents: [intent({ metric: "profit" })] });
    const done: any = await graph.invoke(
      { threadId: "rpt-pft", tenantId: "t1", userMessage: "what is our profit this month?" },
      config("rpt-pft"),
    );
    // Stub default P&L: income 5000, expenses 3000, net profit 2000.
    expect(done.result.summary).toContain("2,000");
    expect(done.result.summary).toContain("accrual");
  });

  it("XERO-RPT-009: top expense categories come from P&L rows, ranked", async () => {
    const { graph } = buildGraph({
      intents: [intent({ metric: "top_expenses", topN: 5, groupBy: "account" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-top", tenantId: "t1", userMessage: "top 5 expense categories?" },
      config("rpt-top"),
    );
    expect(done.result.status).toBe("answered");
    expect(done.result.summary).toContain("Office Expenses");
  });

  it("XERO-RPT-007: balance sheet is requested as of a date", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ metric: "balance_sheet" })],
      seed: {
        invoices: [],
        reports: {
          BalanceSheet: {
            ReportName: "BalanceSheet",
            Rows: [
              {
                RowType: "Section",
                Title: "Assets",
                Rows: [
                  {
                    RowType: "SummaryRow",
                    Cells: [{ Value: "Total Assets" }, { Value: "10,000.00" }],
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-bs", tenantId: "t1", userMessage: "show our balance sheet" },
      config("rpt-bs"),
    );
    expect(done.result.summary).toContain("as of 2026-07-31");
    expect(done.result.summary).toContain("10,000");
    expect(xeroTool.reportRequests[0]).toMatchObject({ name: "BalanceSheet" });
  });
});

describe("report graph — document queries", () => {
  it("XERO-GRAPH-INV-001: lists draft customer invoices as read-only ACCREC DRAFT documents", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ metric: "draft_invoices", periodToken: "none" })],
      seed: {
        invoices: [
          {
            InvoiceID: "draft-sales",
            InvoiceNumber: "DRAFT-INV-1",
            Type: "ACCREC",
            Status: "DRAFT",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-05",
            DueDate: "2026-07-31",
            Total: 250,
            CurrencyCode: "USD",
          },
          {
            InvoiceID: "draft-bill",
            InvoiceNumber: "DRAFT-BILL-1",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { ContactID: "c-sup", Name: "Supplier Co" },
            Date: "2026-07-05",
            Total: 500,
            CurrencyCode: "USD",
          },
        ],
      },
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-draft-inv", tenantId: "t1", userMessage: "show me the draft invoices" },
      config("rpt-draft-inv"),
    );

    expect(done.result.status).toBe("answered");
    expect(done.result.summary).toContain("DRAFT-INV-1");
    expect(done.result.summary).toContain("Acme");
    expect(done.result.summary).toContain("USD 250");
    expect(done.result.summary).not.toContain("DRAFT-BILL-1");
    expect(xeroTool.invoiceQueries[0]).toMatchObject({
      type: "ACCREC",
      statuses: ["DRAFT"],
    });
    expect(xeroTool.invoiceQueries[0].unpaidOnly).toBeUndefined();
    expect(xeroTool.invoiceQueries[0].dateFrom).toBeUndefined();
    expectNoWrites(xeroTool);
  });

  it("XERO-GRAPH-BILL-001: lists draft bills as read-only ACCPAY DRAFT documents", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ metric: "draft_bills", periodToken: "none" })],
      seed: {
        invoices: [
          {
            InvoiceID: "draft-sales",
            InvoiceNumber: "DRAFT-INV-1",
            Type: "ACCREC",
            Status: "DRAFT",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-05",
            Total: 250,
          },
          {
            InvoiceID: "draft-bill",
            InvoiceNumber: "DRAFT-BILL-1",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { ContactID: "c-sup", Name: "Supplier Co" },
            Date: "2026-07-05",
            Total: 500,
          },
        ],
      },
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-draft-bill", tenantId: "t1", userMessage: "show draft bills" },
      config("rpt-draft-bill"),
    );

    expect(done.result.status).toBe("answered");
    expect(done.result.summary).toContain("DRAFT-BILL-1");
    expect(done.result.summary).not.toContain("DRAFT-INV-1");
    expect(xeroTool.invoiceQueries[0]).toMatchObject({
      type: "ACCPAY",
      statuses: ["DRAFT"],
    });
    expect(xeroTool.invoiceQueries[0].unpaidOnly).toBeUndefined();
    expectNoWrites(xeroTool);
  });

  it("XERO-GRAPH-INV-002: paid and voided invoice lists query their exact statuses", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({ metric: "paid_invoices", periodToken: "this_month" }),
        intent({ metric: "voided_invoices", periodToken: "none" }),
      ],
      seed: {
        invoices: [
          {
            InvoiceID: "paid-sales",
            InvoiceNumber: "PAID-INV-1",
            Type: "ACCREC",
            Status: "PAID",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-05",
            Total: 700,
          },
          {
            InvoiceID: "void-sales",
            InvoiceNumber: "VOID-INV-1",
            Type: "ACCREC",
            Status: "VOIDED",
            Contact: { ContactID: "c-beta", Name: "Beta Ltd" },
            Date: "2026-06-05",
            Total: 900,
          },
        ],
      },
    });

    const paid: any = await graph.invoke(
      { threadId: "rpt-paid-inv", tenantId: "t1", userMessage: "show paid invoices this month" },
      config("rpt-paid-inv"),
    );
    const voided: any = await graph.invoke(
      { threadId: "rpt-void-inv", tenantId: "t1", userMessage: "show voided invoices" },
      config("rpt-void-inv"),
    );

    expect(paid.result.summary).toContain("PAID-INV-1");
    expect(voided.result.summary).toContain("VOID-INV-1");
    expect(xeroTool.invoiceQueries[0]).toMatchObject({
      type: "ACCREC",
      statuses: ["PAID"],
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
    });
    expect(xeroTool.invoiceQueries[1]).toMatchObject({
      type: "ACCREC",
      statuses: ["VOIDED"],
    });
    expect(xeroTool.invoiceQueries[1].dateFrom).toBeUndefined();
    expectNoWrites(xeroTool);
  });

  it("XERO-GRAPH-RPT-001: outstanding invoice answers use invoice CurrencyCode, not base currency", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ metric: "unpaid_invoices", periodToken: "this_month" })],
      seed: {
        organisation: { BaseCurrency: "IDR", Timezone: "Asia/Singapore" },
        invoices: [
          {
            InvoiceID: "usd-1",
            InvoiceNumber: "INV-0003",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-01",
            DueDate: "2026-07-31",
            AmountDue: 250,
            CurrencyCode: "USD",
          },
          {
            InvoiceID: "usd-2",
            InvoiceNumber: "INV-0005",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-05",
            DueDate: "2026-07-31",
            AmountDue: 555,
            CurrencyCode: "USD",
          },
          {
            InvoiceID: "usd-3",
            InvoiceNumber: "INV-0007",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-07",
            DueDate: "2026-07-31",
            AmountDue: 666,
            CurrencyCode: "USD",
          },
          {
            InvoiceID: "usd-4",
            InvoiceNumber: "INV-0015",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-09",
            DueDate: "2026-07-31",
            AmountDue: 821,
            CurrencyCode: "USD",
          },
        ],
      },
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-usd-outstanding", tenantId: "t1", userMessage: "How much is outstanding this month?" },
      config("rpt-usd-outstanding"),
    );

    expect(done.result.summary).toContain("USD 2,292");
    expect(done.result.summary).toContain("INV-0003 Acme: USD 250 due");
    expect(done.result.summary).not.toContain("IDR 2,292");
    expect(xeroTool.invoiceQueries[0]).toMatchObject({
      type: "ACCREC",
      statuses: ["AUTHORISED"],
      unpaidOnly: true,
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
    });
  });

  it("XERO-GRAPH-RPT-002: mixed-currency invoice lists show per-currency subtotals", async () => {
    const { graph } = buildGraph({
      intents: [intent({ metric: "unpaid_invoices", periodToken: "this_month" })],
      seed: {
        organisation: { BaseCurrency: "IDR", Timezone: "Asia/Singapore" },
        invoices: [
          {
            InvoiceID: "usd-1",
            InvoiceNumber: "INV-USD",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            Date: "2026-07-01",
            AmountDue: 1000,
            CurrencyCode: "USD",
          },
          {
            InvoiceID: "idr-1",
            InvoiceNumber: "INV-IDR",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-beta", Name: "Beta Ltd" },
            Date: "2026-07-01",
            AmountDue: 2000,
            CurrencyCode: "IDR",
          },
        ],
      },
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-mixed-currency", tenantId: "t1", userMessage: "How much is outstanding this month?" },
      config("rpt-mixed-currency"),
    );

    expect(done.result.summary).toContain("IDR 2,000");
    expect(done.result.summary).toContain("USD 1,000");
    expect(done.result.summary).toContain("INV-IDR Beta Ltd: IDR 2,000 due");
    expect(done.result.summary).toContain("INV-USD Acme: USD 1,000 due");
    expect(done.result.summary).not.toContain("IDR 3,000");
    expect(done.result.summary).not.toContain("USD 3,000");
  });

  it("XERO-EXP-011 / XERO-RPT-019: overdue excludes PAID and VOIDED documents", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ metric: "overdue_invoices", periodToken: "none" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-ovd", tenantId: "t1", userMessage: "how much money is overdue from customers?" },
      config("rpt-ovd"),
    );
    // Only INV-1 (1000) is overdue; INV-3 is past due but PAID.
    expect(done.result.summary).toContain("INV-1");
    expect(done.result.summary).not.toContain("INV-3");
    expect(done.result.summary).toContain("1,000");
    const q = xeroTool.invoiceQueries[0];
    expect(q).toMatchObject({
      type: "ACCREC",
      unpaidOnly: true,
      dueBefore: "2026-07-12",
      statuses: ["AUTHORISED"],
    });
  });

  it("XERO-RPT-018: 'unpaid bills over 10 million' applies the amount filter", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          metric: "unpaid_invoices",
          periodToken: "none",
          minAmount: 10_000_000,
        }),
      ],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-min", tenantId: "t1", userMessage: "unpaid invoices over Rp10 million" },
      config("rpt-min"),
    );
    expect(done.result.summary).toContain("INV-2");
    expect(done.result.summary).not.toContain("INV-1:");
    expect(xeroTool.invoiceQueries[0].amountDueMin).toBe(10_000_000);
  });

  it("XERO-EXP-010: 'bills due next week' uses due dates in the org timezone", async () => {
    const { graph } = buildGraph({
      intents: [intent({ metric: "bills_due_soon", periodToken: "none" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-due", tenantId: "t1", userMessage: "which bills are due next week?" },
      config("rpt-due"),
    );
    // Next week in Singapore from Sunday 2026-07-12 = Mon 13 – Sun 19; BILL-1 due 07-15.
    expect(done.result.summary).toContain("BILL-1");
    expect(done.result.summary).not.toContain("BILL-2");
  });

  it("XERO-CON-006: 'how much did we invoice Acme this year' resolves the contact and sums sales invoices", async () => {
    const { graph } = buildGraph({
      intents: [
        intent({
          metric: "invoice_total_for_contact",
          periodToken: "this_year",
          contactName: "Acme",
        }),
      ],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-con", tenantId: "t1", userMessage: "how much did we invoice Acme this year?" },
      config("rpt-con"),
    );
    // INV-1 (1000, AUTHORISED) + INV-3 (500, PAID) — both count; VOIDED never would.
    expect(done.result.summary).toContain("1,500");
    expect(done.result.summary).toContain("Acme");
  });

  it("XERO-EXP-007: expenses by supplier groups bill totals without double-counting payments", async () => {
    const { graph } = buildGraph({
      intents: [
        intent({
          metric: "expenses_by_supplier",
          periodToken: "custom",
          from: "2026-06-01",
          to: "2026-06-30",
          groupBy: "contact",
        }),
      ],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-sup", tenantId: "t1", userMessage: "expenses by supplier for June" },
      config("rpt-sup"),
    );
    // Only BILL-1 (300, AUTHORISED, dated June); BILL-2 is VOIDED.
    expect(done.result.summary).toContain("Supplier Co: SGD 300");
    expect(done.result.summary).not.toContain("999");
  });
});

describe("report graph — read-only guarantee", () => {
  it("XERO-AI-007: a full run never interrupts for approval and never writes", async () => {
    const { graph, xeroTool } = buildGraph();
    const done: any = await graph.invoke(
      { threadId: "rpt-ro", tenantId: "t1", userMessage: "expenses this month?" },
      config("rpt-ro"),
    );
    expect(done.__interrupt__).toBeUndefined();
    expect(done.result.status).toBe("answered");
    // Zero write records of any kind.
    expectNoWrites(xeroTool);
  });

  it("XERO-AI-014: unsupported questions explain the limitation", async () => {
    const { graph } = buildGraph({
      intents: [intent({ metric: "unsupported" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-unsup", tenantId: "t1", userMessage: "what will bitcoin do next month?" },
      config("rpt-unsup"),
    );
    expect(done.result.status).toBe("failed");
    expect(done.result.summary).toContain("can't answer");
  });

  it("XERO-RPT-015: 'how are we doing' produces a compact overview", async () => {
    const { graph } = buildGraph({
      intents: [intent({ metric: "overview", periodToken: "none" })],
    });
    const done: any = await graph.invoke(
      { threadId: "rpt-ovw", tenantId: "t1", userMessage: "how are we doing?" },
      config("rpt-ovw"),
    );
    expect(done.result.status).toBe("answered");
    for (const label of ["Revenue", "Expenses", "Profit", "receivables", "payables"])
      expect(done.result.summary).toContain(label);
  });
});
