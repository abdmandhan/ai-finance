import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { PaymentIntent } from "@/schemas";
import type { ILlmService, XeroAuth } from "@/services";
import {
  StubXeroTool,
  type StubXeroSeed,
  type XeroInvoiceDetail,
} from "@/tools";
import type { PaymentDeps } from "@/nodes";
import { buildPaymentGraph } from "./payment.graph";

const NOW = () => new Date("2026-07-12T10:00:00Z");

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    action: "apply_payment",
    targetKind: "bill",
    invoiceRef: "INV-100",
    contactName: null,
    amount: null,
    date: null,
    bankAccountHint: null,
    reference: null,
    creditNoteLines: null,
    allocateToInvoiceRef: null,
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

const OPEN_BILL: XeroInvoiceDetail = {
  InvoiceID: "i-100",
  InvoiceNumber: "INV-100",
  Type: "ACCPAY",
  Status: "AUTHORISED",
  Contact: { ContactID: "c-sup", Name: "Supplier Co" },
  Date: "2026-06-15",
  DueDate: "2026-07-01",
  Total: 500,
  AmountDue: 500,
  AmountPaid: 0,
};

function buildGraph(
  opts: { intents?: PaymentIntent[]; seed?: StubXeroSeed } = {},
) {
  const logger = pino({ level: "silent" });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { invoke: vi.fn(), extract, chat: vi.fn() };
  // Single bank account by default so payments resolve it without a hint;
  // the "asks which bank" test seeds two explicitly.
  const xeroTool = new StubXeroTool(
    opts.seed ?? {
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
      invoices: [{ ...OPEN_BILL }],
      accounts: [
        { Code: "090", Name: "Business Bank Account", Type: "BANK", Status: "ACTIVE" },
        { Code: "400", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE" },
      ],
    },
  );
  const deps: PaymentDeps = {
    llmService,
    xeroTool,
    resolveXeroAuth: async () => fakeAuth,
    logger,
    now: NOW,
  };
  return { graph: buildPaymentGraph(deps, new MemorySaver()), xeroTool };
}

function config(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

describe("payment graph — apply payment", () => {
  it("XERO-PAY-001: pays in full after approval, exactly one payment with correct fields", async () => {
    const { graph, xeroTool } = buildGraph();
    const cfg = config("pay-full");

    const paused: any = await graph.invoke(
      { threadId: "pay-full", tenantId: "t1", userMessage: "pay INV-100" },
      cfg,
    );
    // Approval comes BEFORE the write — nothing recorded yet.
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    expect(paused.__interrupt__?.[0]?.value?.approval?.name).toBe(
      "xero_apply_payment",
    );
    expect(xeroTool.createdPayments).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(resumed.result.completedApproval?.name).toBe("xero_apply_payment");
    expect(resumed.result.remainingAmountDue).toBe(0);
    expect(xeroTool.createdPayments).toHaveLength(1);
    expect(xeroTool.createdPayments[0]).toMatchObject({
      Invoice: { InvoiceID: "i-100" },
      Account: { Code: "090" },
      Amount: 500,
      Date: "2026-07-12",
    });
  });

  it("XERO-PAY-004 / XERO-INV-014: partial payment leaves the remaining balance", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ amount: 100 })],
    });
    const cfg = config("pay-part");

    await graph.invoke(
      { threadId: "pay-part", tenantId: "t1", userMessage: "pay 100 of INV-100" },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(resumed.result.remainingAmountDue).toBe(400);
    expect(xeroTool.createdPayments[0].Amount).toBe(100);
    expect(resumed.result.summary).toContain("400");
  });

  it("XERO-PAY-002: never over-applies — asks instead of writing", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ amount: 600 })],
    });
    const paused: any = await graph.invoke(
      { threadId: "pay-over", tenantId: "t1", userMessage: "pay 600 on INV-100" },
      config("pay-over"),
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(paused.__interrupt__?.[0]?.value?.message).toContain("overpayment");
    expect(xeroTool.createdPayments).toHaveLength(0);
  });

  it("XERO-INV-013: resolves the bank account from a hint like 'BCA'", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ bankAccountHint: "BCA", date: "2026-07-11" })],
      seed: {
        contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
        invoices: [{ ...OPEN_BILL }],
        accounts: [
          { Code: "090", Name: "BCA Checking", Type: "BANK", Status: "ACTIVE" },
          { Code: "091", Name: "Mandiri", Type: "BANK", Status: "ACTIVE" },
          { Code: "400", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE" },
        ],
      },
    });
    const cfg = config("pay-bca");
    await graph.invoke(
      {
        threadId: "pay-bca",
        tenantId: "t1",
        userMessage: "Mark bill INV-100 as paid yesterday from BCA",
      },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(xeroTool.createdPayments[0]).toMatchObject({
      Account: { Code: "090" },
      Date: "2026-07-11",
    });
  });

  it("asks which bank account when several exist and no hint was given", async () => {
    const { graph, xeroTool } = buildGraph({
      seed: {
        contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
        invoices: [{ ...OPEN_BILL }],
        accounts: [
          { Code: "090", Name: "BCA Checking", Type: "BANK", Status: "ACTIVE" },
          { Code: "091", Name: "Mandiri", Type: "BANK", Status: "ACTIVE" },
        ],
      },
    });
    const paused: any = await graph.invoke(
      { threadId: "pay-nobank", tenantId: "t1", userMessage: "pay INV-100" },
      config("pay-nobank"),
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(paused.__interrupt__?.[0]?.value?.message).toContain("bank account");
    expect(xeroTool.createdPayments).toHaveLength(0);
  });

  it("refuses to pay a draft — explains instead of failing opaquely", async () => {
    const { graph, xeroTool } = buildGraph({
      seed: {
        contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
        invoices: [{ ...OPEN_BILL, Status: "DRAFT" }],
      },
    });
    const done: any = await graph.invoke(
      { threadId: "pay-draft", tenantId: "t1", userMessage: "pay INV-100" },
      config("pay-draft"),
    );
    expect(done.result.status).toBe("failed");
    expect(done.result.summary).toContain("draft");
    expect(xeroTool.createdPayments).toHaveLength(0);
  });

  it("XERO-AI-006: rejection at the approval gate writes nothing", async () => {
    const { graph, xeroTool } = buildGraph();
    const cfg = config("pay-reject");
    await graph.invoke(
      { threadId: "pay-reject", tenantId: "t1", userMessage: "pay INV-100" },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: false } }),
      cfg,
    );
    expect(resumed.result.status).toBe("rejected");
    expect(xeroTool.createdPayments).toHaveLength(0);
    expect(xeroTool.statusUpdates).toHaveLength(0);
  });
});

describe("payment graph — reversal", () => {
  it("XERO-PAY-005: locates the payment, needs approval, then deletes it", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
      invoices: [{ ...OPEN_BILL }],
      payments: [
        {
          PaymentID: "pay-1",
          Status: "AUTHORISED",
          Amount: 200,
          Date: "2026-07-11",
          Invoice: { InvoiceID: "i-100", InvoiceNumber: "INV-100" },
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ action: "reverse_payment", invoiceRef: null, date: "2026-07-11" })],
      seed,
    });
    const cfg = config("pay-rev");
    const paused: any = await graph.invoke(
      { threadId: "pay-rev", tenantId: "t1", userMessage: "reverse yesterday's payment" },
      cfg,
    );
    expect(paused.__interrupt__?.[0]?.value?.approval?.name).toBe(
      "xero_reverse_payment",
    );
    expect(xeroTool.deletedPayments).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("reversed");
    expect(resumed.result.completedApproval?.name).toBe(
      "xero_reverse_payment",
    );
    expect(xeroTool.deletedPayments).toEqual(["pay-1"]);
  });

  it("rejecting a reversal deletes nothing", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ action: "reverse_payment", invoiceRef: null, date: "2026-07-11" })],
      seed: {
        invoices: [{ ...OPEN_BILL }],
        payments: [
          {
            PaymentID: "pay-1",
            Status: "AUTHORISED",
            Amount: 200,
            Date: "2026-07-11",
            Invoice: { InvoiceID: "i-100", InvoiceNumber: "INV-100" },
          },
        ],
      },
    });
    const cfg = config("pay-rev-no");
    await graph.invoke(
      { threadId: "pay-rev-no", tenantId: "t1", userMessage: "undo that payment" },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: false } }),
      cfg,
    );
    expect(resumed.result.status).toBe("rejected");
    expect(xeroTool.deletedPayments).toHaveLength(0);
  });
});

describe("payment graph — credit notes", () => {
  it("XERO-PAY-006/007: creates a credit note and allocates no more than either balance", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          action: "create_credit_note",
          targetKind: "invoice",
          invoiceRef: null,
          contactName: "Acme",
          amount: 800,
          allocateToInvoiceRef: "INV-200",
        }),
      ],
      seed: {
        contacts: [{ ContactID: "c-acme", Name: "Acme" }],
        invoices: [
          {
            InvoiceID: "i-200",
            InvoiceNumber: "INV-200",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            AmountDue: 500,
          },
        ],
      },
    });
    const cfg = config("cn-1");
    const paused: any = await graph.invoke(
      {
        threadId: "cn-1",
        tenantId: "t1",
        userMessage: "credit Acme 800 for the returned items, apply to INV-200",
      },
      cfg,
    );
    expect(paused.__interrupt__?.[0]?.value?.approval?.name).toBe(
      "xero_create_credit_note",
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(resumed.result.completedApproval?.name).toBe(
      "xero_create_credit_note",
    );
    expect(xeroTool.createdCreditNotes).toHaveLength(1);
    expect(xeroTool.createdCreditNotes[0].Type).toBe("ACCRECCREDIT");
    // Allocation capped at the invoice's 500 outstanding, not the 800 credit.
    expect(xeroTool.allocations).toEqual([
      expect.objectContaining({ invoiceId: "i-200", amount: 500 }),
    ]);
  });
});

describe("payment graph — void", () => {
  it("XERO-INV-015: void requires approval and validates state", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ action: "void_invoice" })],
    });
    const cfg = config("void-1");
    const paused: any = await graph.invoke(
      { threadId: "void-1", tenantId: "t1", userMessage: "void INV-100" },
      cfg,
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    expect(paused.__interrupt__?.[0]?.value?.message).toContain("Void");
    expect(xeroTool.statusUpdates).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("voided");
    expect(resumed.result.completedApproval?.name).toBe("xero_void_invoice");
    expect(xeroTool.statusUpdates).toEqual([
      { invoiceId: "i-100", status: "VOIDED" },
    ]);
  });

  it("XERO-EXP-014: refuses to void a paid document and explains the correction path", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ action: "void_invoice" })],
      seed: {
        invoices: [
          { ...OPEN_BILL, Status: "PAID", AmountDue: 0, AmountPaid: 500 },
        ],
      },
    });
    const done: any = await graph.invoke(
      { threadId: "void-paid", tenantId: "t1", userMessage: "delete this paid bill" },
      config("void-paid"),
    );
    expect(done.result.status).toBe("failed");
    expect(done.result.summary).toContain("credit note");
    expect(xeroTool.statusUpdates).toHaveLength(0);
  });
});

describe("payment graph — guardrails", () => {
  it("refund_credit remains unsupported and performs no Xero write", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ action: "refund_credit" })],
    });

    const done: any = await graph.invoke(
      { threadId: "pay-refund-credit", tenantId: "t1", userMessage: "refund the remaining credit" },
      config("pay-refund-credit"),
    );

    expect(done.result.status).toBe("failed");
    expect(done.result.summary).toContain("Refunding remaining credit");
    expect(xeroTool.createdPayments).toHaveLength(0);
    expect(xeroTool.deletedPayments).toHaveLength(0);
    expect(xeroTool.createdCreditNotes).toHaveLength(0);
    expect(xeroTool.statusUpdates).toHaveLength(0);
  });

  it("unsupported requests fail fast without lookups or writes", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ action: "unsupported" })],
    });
    const done: any = await graph.invoke(
      { threadId: "pay-unsup", tenantId: "t1", userMessage: "write me a poem" },
      config("pay-unsup"),
    );
    expect(done.result.status).toBe("failed");
    expect(xeroTool.createdPayments).toHaveLength(0);
    expect(xeroTool.invoiceQueries).toHaveLength(0);
  });

  it("XERO-AI-003: several matching open documents ask for disambiguation", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ invoiceRef: null, contactName: "Supplier Co" })],
      seed: {
        contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
        invoices: [
          { ...OPEN_BILL },
          { ...OPEN_BILL, InvoiceID: "i-101", InvoiceNumber: "INV-101" },
        ],
      },
    });
    const paused: any = await graph.invoke(
      { threadId: "pay-ambig", tenantId: "t1", userMessage: "pay Supplier Co's bill" },
      config("pay-ambig"),
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(xeroTool.createdPayments).toHaveLength(0);
  });
});
