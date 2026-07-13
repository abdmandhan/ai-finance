import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { ExpenseIntent } from "@/schemas";
import type { ILlmService, XeroAuth } from "@/services";
import { StubXeroTool, type StubXeroSeed } from "@/tools";
import type { ExpenseDeps } from "@/nodes";
import { buildExpenseGraph } from "./expense.graph";

const NOW = () => new Date("2026-07-12T10:00:00Z");

function intent(over: Partial<ExpenseIntent> = {}): ExpenseIntent {
  return {
    kind: "spend",
    contactName: null,
    lineItems: [],
    amount: 20,
    currencyCode: null,
    date: null,
    reference: null,
    bankAccountHint: null,
    fromAccountHint: null,
    toAccountHint: null,
    taxRatePercent: null,
    taxAmount: null,
    amountsAreTaxInclusive: false,
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

// One bank account by default so no-hint requests resolve deterministically.
const ONE_BANK_SEED: StubXeroSeed = {
  contacts: [{ ContactID: "c-acme", Name: "Acme" }],
  accounts: [
    { Code: "090", Name: "Business Bank Account", Type: "BANK", Status: "ACTIVE" },
    { Code: "400", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE", TaxType: "INPUT" },
    { Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT" },
  ],
};

const TWO_BANK_SEED: StubXeroSeed = {
  ...ONE_BANK_SEED,
  accounts: [
    ...(ONE_BANK_SEED.accounts ?? []),
    { Code: "091", Name: "Savings", Type: "BANK", Status: "ACTIVE" },
  ],
};

function buildGraph(
  opts: {
    intents?: ExpenseIntent[];
    seed?: StubXeroSeed;
    withFetch?: boolean;
  } = {},
) {
  const logger = pino({ level: "silent" });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { invoke: vi.fn(), extract, chat: vi.fn() };
  const xeroTool = new StubXeroTool(opts.seed ?? ONE_BANK_SEED);
  const fetchAttachment = vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,AAA",
  }));
  const deps: ExpenseDeps = {
    llmService,
    xeroTool,
    resolveXeroAuth: async () => fakeAuth,
    orgDefaults: { taxType: "", expenseAccountCode: "", revenueAccountCode: "" },
    ...(opts.withFetch ? { fetchAttachment } : {}),
    logger,
    now: NOW,
  };
  return {
    graph: buildExpenseGraph(deps, new MemorySaver()),
    xeroTool,
    fetchAttachment,
  };
}

function config(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

describe("expense graph — spend money", () => {
  it("XERO-EXP-002 / XERO-BANK-001: records a spend-money after approval, nothing before", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ lineItems: [{ description: "Parking", quantity: 1, unitAmount: 20 }], amount: null })],
    });
    const cfg = config("exp-spend");

    const paused: any = await graph.invoke(
      {
        threadId: "exp-spend",
        tenantId: "t1",
        userMessage: "Record $20 for parking, paid from the business bank account",
      },
      cfg,
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    expect(paused.__interrupt__?.[0]?.value?.approval?.name).toBe(
      "xero_spend_money",
    );
    expect(xeroTool.bankTransactions).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(xeroTool.bankTransactions).toHaveLength(1);
    expect(xeroTool.bankTransactions[0]).toMatchObject({
      Type: "SPEND",
      BankAccount: { Code: "090" },
      Date: "2026-07-12",
    });
    // Line picked up the org expense account default.
    expect(xeroTool.bankTransactions[0].LineItems[0].AccountCode).toBe("400");
  });

  it("XERO-DOC-003: a receipt becomes a SPEND transaction, never a sales invoice", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          contactName: "Coffee Shop",
          lineItems: [{ description: "Coffee", quantity: 2, unitAmount: 5 }],
          amount: null,
        }),
      ],
    });
    const cfg = config("exp-receipt");
    await graph.invoke(
      { threadId: "exp-receipt", tenantId: "t1", userMessage: "record this expense" },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(xeroTool.bankTransactions[0].Type).toBe("SPEND");
    expect(xeroTool.created).toHaveLength(0); // no invoice of any kind
  });

  it("XERO-BANK-009: attaches the source receipt to the created transaction", async () => {
    const { graph, xeroTool } = buildGraph({ withFetch: true });
    const cfg = config("exp-attach");
    await graph.invoke(
      {
        threadId: "exp-attach",
        tenantId: "t1",
        userMessage: "record this receipt",
        attachments: [
          { url: "http://minio/r.jpg", mimeType: "image/jpeg", fileName: "r.jpg" },
        ],
      },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(xeroTool.attachedToBankTransactions).toHaveLength(1);
    expect(xeroTool.attachedToBankTransactions[0].fileName).toBe("r.jpg");
  });

  it("asks which bank account when several exist and no hint was given", async () => {
    const { graph, xeroTool } = buildGraph({ seed: TWO_BANK_SEED });
    const paused: any = await graph.invoke(
      { threadId: "exp-nobank", tenantId: "t1", userMessage: "record $20 parking" },
      config("exp-nobank"),
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(xeroTool.bankTransactions).toHaveLength(0);
  });

  it("XERO-AI-006: rejection writes nothing", async () => {
    const { graph, xeroTool } = buildGraph();
    const cfg = config("exp-reject");
    await graph.invoke(
      { threadId: "exp-reject", tenantId: "t1", userMessage: "record $20 parking" },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: false } }),
      cfg,
    );
    expect(resumed.result.status).toBe("rejected");
    expect(xeroTool.bankTransactions).toHaveLength(0);
    expect(xeroTool.bankTransfers).toHaveLength(0);
  });
});

describe("expense graph — receive money", () => {
  it("XERO-BANK-002: money from a contact with open invoices asks payment-vs-receive", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ kind: "receive", contactName: "Acme", amount: 2000 })],
      seed: {
        ...ONE_BANK_SEED,
        invoices: [
          {
            InvoiceID: "i-200",
            InvoiceNumber: "INV-200",
            Type: "ACCREC",
            Status: "AUTHORISED",
            Contact: { ContactID: "c-acme", Name: "Acme" },
            AmountDue: 2000,
          },
        ],
      },
    });
    const paused: any = await graph.invoke(
      {
        threadId: "exp-recv",
        tenantId: "t1",
        userMessage: "Record Rp2,000,000 received from Acme",
      },
      config("exp-recv"),
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(paused.__interrupt__?.[0]?.value?.message).toContain("INV-200");
    expect(xeroTool.bankTransactions).toHaveLength(0);
  });

  it("records receive-money with the revenue account default when no open invoices", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ kind: "receive", contactName: "Acme", amount: 500 })],
    });
    const cfg = config("exp-recv-ok");
    await graph.invoke(
      { threadId: "exp-recv-ok", tenantId: "t1", userMessage: "received 500 from Acme" },
      cfg,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(xeroTool.bankTransactions[0]).toMatchObject({
      Type: "RECEIVE",
      Contact: { ContactID: "c-acme" },
    });
    expect(xeroTool.bankTransactions[0].LineItems[0].AccountCode).toBe("200");
  });
});

describe("expense graph — transfers", () => {
  it("XERO-BANK-003: transfers between two distinct accounts after approval", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          kind: "transfer",
          amount: 1000,
          fromAccountHint: "business",
          toAccountHint: "savings",
        }),
      ],
      seed: TWO_BANK_SEED,
    });
    const cfg = config("exp-xfer");
    const paused: any = await graph.invoke(
      {
        threadId: "exp-xfer",
        tenantId: "t1",
        userMessage: "Transfer $1,000 from checking to savings",
      },
      cfg,
    );
    expect(paused.__interrupt__?.[0]?.value?.approval?.name).toBe(
      "xero_bank_transfer",
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      cfg,
    );
    expect(resumed.result.status).toBe("created");
    expect(xeroTool.bankTransfers).toEqual([
      expect.objectContaining({
        FromBankAccount: { Code: "090" },
        ToBankAccount: { Code: "091" },
        Amount: 1000,
      }),
    ]);
  });

  it("XERO-BANK-004: rejects a transfer when source and destination are identical", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          kind: "transfer",
          amount: 1000,
          fromAccountHint: "business",
          toAccountHint: "business bank",
        }),
      ],
      seed: TWO_BANK_SEED,
    });
    const done: any = await graph.invoke(
      {
        threadId: "exp-xfer-same",
        tenantId: "t1",
        userMessage: "transfer 1000 from business to business bank",
      },
      config("exp-xfer-same"),
    );
    expect(done.result.status).toBe("failed");
    expect(done.result.summary).toContain("same account");
    expect(xeroTool.bankTransfers).toHaveLength(0);
  });
});

describe("expense graph — guardrails", () => {
  it("unsupported (e.g. a bill payable later) routes away without writing", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ kind: "unsupported" })],
    });
    const done: any = await graph.invoke(
      {
        threadId: "exp-unsup",
        tenantId: "t1",
        userMessage: "record this supplier invoice payable next month",
      },
      config("exp-unsup"),
    );
    expect(done.result.status).toBe("failed");
    expect(done.result.summary).toContain("bill workflow");
    expect(xeroTool.bankTransactions).toHaveLength(0);
  });

  it("XERO-DOC-014: no amount → asks instead of inventing", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          amount: null,
          lineItems: [],
          clarificationQuestion: "What was the total amount?",
        }),
      ],
    });
    const paused: any = await graph.invoke(
      { threadId: "exp-noamt", tenantId: "t1", userMessage: "record this expense" },
      config("exp-noamt"),
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(xeroTool.bankTransactions).toHaveLength(0);
  });
});
