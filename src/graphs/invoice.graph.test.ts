import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { InvoiceIntent } from "@/schemas";
import type { ILlmService, XeroAuth } from "@/services";
import {
  InMemoryInvoiceRetainersTool,
  StubXeroTool,
  type StubXeroSeed,
  type XeroContact,
} from "@/tools";
import type { InvoiceDeps } from "@/nodes";
import { buildInvoiceGraph } from "./invoice.graph";

function intent(over: Partial<InvoiceIntent> = {}): InvoiceIntent {
  return {
    action: "create_invoice",
    docType: "sales",
    contactName: "Acme",
    lineItems: [{ description: "Consulting", quantity: 10, unitAmount: 150 }],
    reference: null,
    date: null,
    dueDate: null,
    duePolicy: null,
    currencyCode: null,
    targetInvoiceRef: null,
    amendmentReason: null,
    quotedFxRate: null,
    useRetainer: false,
    retainerName: null,
    retainer: null,
    serviceChargeAmount: null,
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

function buildGraph(
  opts: {
    intents?: InvoiceIntent[];
    contacts?: XeroContact[];
    seed?: StubXeroSeed;
    withFetch?: boolean;
    invoiceRetainersTool?: InMemoryInvoiceRetainersTool;
    now?: () => Date;
  } = {},
) {
  const logger = pino({ level: "silent" });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { invoke: vi.fn(), extract, chat: vi.fn() };
  const xeroTool = new StubXeroTool(
    opts.seed ?? opts.contacts ?? [{ ContactID: "c-acme", Name: "Acme" }],
  );
  const fetchAttachment = vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,AAA",
  }));
  const deps: InvoiceDeps = {
    llmService,
    xeroTool,
    resolveXeroAuth: async () => fakeAuth,
    orgDefaults: {
      taxType: "",
      expenseAccountCode: "",
      revenueAccountCode: "",
    },
    invoiceRetainersTool: opts.invoiceRetainersTool,
    now: opts.now,
    ...(opts.withFetch ? { fetchAttachment } : {}),
    logger,
  };
  return {
    graph: buildInvoiceGraph(deps, new MemorySaver()),
    xeroTool,
    fetchAttachment,
  };
}

describe("invoice graph — draft → approve → authorise", () => {
  it("creates a DRAFT, pauses for approval, then authorises on approve", async () => {
    const { graph, xeroTool } = buildGraph();
    const config = { configurable: { thread_id: "inv-approve" } };

    const paused: any = await graph.invoke(
      {
        threadId: "inv-approve",
        tenantId: "tenant-1",
        userMessage: "invoice Acme 10 hours at 150",
      },
      config,
    );
    // Draft created; graph paused awaiting approval.
    expect(xeroTool.created).toHaveLength(1);
    expect(xeroTool.created[0].Status).toBe("DRAFT");
    expect(xeroTool.created[0].Type).toBe("ACCREC");
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    expect(xeroTool.authorised).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    expect(resumed.result.invoiceId).toBeTruthy();
    expect(xeroTool.authorised).toHaveLength(1);
  });

  it("leaves the draft unauthorised when the user rejects", async () => {
    const { graph, xeroTool } = buildGraph();
    const config = { configurable: { thread_id: "inv-reject" } };

    await graph.invoke(
      {
        threadId: "inv-reject",
        tenantId: "tenant-1",
        userMessage: "invoice Acme 10 hours at 150",
      },
      config,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: false } }),
      config,
    );
    expect(resumed.result.status).toBe("rejected");
    expect(xeroTool.authorised).toHaveLength(0);
  });

  it("creates the Xero contact when the customer is unknown", async () => {
    const { graph, xeroTool } = buildGraph({ contacts: [] });
    const config = { configurable: { thread_id: "inv-newcontact" } };

    await graph.invoke(
      {
        threadId: "inv-newcontact",
        tenantId: "tenant-1",
        userMessage: "invoice Acme 10 hours at 150",
      },
      config,
    );
    expect(xeroTool.upserted).toHaveLength(1);
    expect(xeroTool.upserted[0].name).toBe("Acme");
    expect(xeroTool.created).toHaveLength(1);
  });

  it("reads attached images and attaches the originals to the draft", async () => {
    const { graph, xeroTool, fetchAttachment } = buildGraph({
      intents: [intent({ docType: "bill", contactName: "Supplier Co" })],
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
      withFetch: true,
    });
    const config = { configurable: { thread_id: "inv-attach" } };

    const paused: any = await graph.invoke(
      {
        threadId: "inv-attach",
        tenantId: "tenant-1",
        userMessage: "add these invoice to xero",
        attachments: [
          {
            url: "http://minio/a.jpg",
            mimeType: "image/jpeg",
            fileName: "a.jpg",
          },
          {
            url: "http://minio/b.jpg",
            mimeType: "image/jpeg",
            fileName: "b.jpg",
          },
        ],
      },
      config,
    );

    // Read one image per attachment for the vision model (2) + re-fetched per attach (2) = 4.
    expect(fetchAttachment).toHaveBeenCalled();
    expect(xeroTool.created).toHaveLength(1);
    expect(xeroTool.attached).toHaveLength(2);
    expect(xeroTool.attached.map((a) => a.fileName)).toEqual([
      "a.jpg",
      "b.jpg",
    ]);
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
  });

  it("reads GST + service charge onto the draft", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [
        intent({
          docType: "bill",
          contactName: "Supplier Co",
          taxRatePercent: 9,
          taxAmount: 12.5,
          serviceChargeAmount: 10,
          amountsAreTaxInclusive: true,
        }),
      ],
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
    });
    const config = { configurable: { thread_id: "inv-gst" } };

    await graph.invoke(
      {
        threadId: "inv-gst",
        tenantId: "tenant-1",
        userMessage: "add this receipt",
      },
      config,
    );

    const inv = xeroTool.created[0];
    expect(inv.LineAmountTypes).toBe("Inclusive");
    // Goods line picked up the matched GST rate (account default is 0% in the stub).
    expect(inv.LineItems[0].TaxType).toBe("GST9");
    // Service charge added as its own taxed line.
    const svc = inv.LineItems.find((l) => l.Description === "Service charge");
    expect(svc?.UnitAmount).toBe(10);
    expect(svc?.TaxType).toBe("GST9");
  });

  it("XERO-DOC-029 / XERO-ERR-010: detects a duplicate reference and asks before creating", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
      invoices: [
        {
          InvoiceID: "i-dup",
          InvoiceNumber: "BILL-77",
          Type: "ACCPAY",
          Status: "AUTHORISED",
          Contact: { ContactID: "c-sup", Name: "Supplier Co" },
          Reference: "INV-2026-0311",
          Date: "2026-03-11",
          LineItems: [
            { Description: "Consulting", Quantity: 10, UnitAmount: 150 },
          ],
          Total: 1500,
          AmountDue: 1500,
        },
      ],
    };
    const dupIntent = intent({
      docType: "bill",
      contactName: "Supplier Co",
      reference: "INV-2026-0311",
      date: "2026-03-11",
    });
    const { graph, xeroTool } = buildGraph({ intents: [dupIntent], seed });
    const config = { configurable: { thread_id: "inv-dup" } };

    const paused: any = await graph.invoke(
      {
        threadId: "inv-dup",
        tenantId: "tenant-1",
        userMessage: "create a bill from this invoice",
      },
      config,
    );
    // Paused BEFORE creating anything.
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");
    expect(paused.__interrupt__?.[0]?.value?.message).toContain(
      "similar document",
    );
    expect(xeroTool.created).toHaveLength(0);

    // "cancel" → nothing created, existing document referenced.
    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "cancel" } }),
      config,
    );
    expect(resumed.result.status).toBe("rejected");
    expect(xeroTool.created).toHaveLength(0);
  });

  it("XERO-DOC-029: 'create anyway' proceeds past the duplicate check", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
      invoices: [
        {
          InvoiceID: "i-dup",
          InvoiceNumber: "BILL-77",
          Type: "ACCPAY",
          Status: "AUTHORISED",
          Contact: { ContactID: "c-sup", Name: "Supplier Co" },
          Reference: "INV-2026-0311",
          Date: "2026-03-11",
          LineItems: [
            { Description: "Consulting", Quantity: 10, UnitAmount: 150 },
          ],
          Total: 1500,
          AmountDue: 1500,
        },
      ],
    };
    const dupIntent = intent({
      docType: "bill",
      contactName: "Supplier Co",
      reference: "INV-2026-0311",
      date: "2026-03-11",
    });
    const { graph, xeroTool } = buildGraph({ intents: [dupIntent], seed });
    const config = { configurable: { thread_id: "inv-dup-force" } };

    await graph.invoke(
      {
        threadId: "inv-dup-force",
        tenantId: "tenant-1",
        userMessage: "create a bill from this invoice",
      },
      config,
    );
    const paused: any = await graph.invoke(
      new Command({ resume: { reply: "create anyway" } }),
      config,
    );
    // Draft created; now at the usual approval gate.
    expect(xeroTool.created).toHaveLength(1);
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
  });

  it("XERO-DOC-029: a 2-of-4 duplicate candidate does not pause", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
      invoices: [
        {
          InvoiceID: "i-near",
          InvoiceNumber: "INV-NEAR",
          Type: "ACCREC",
          Status: "AUTHORISED",
          Contact: { ContactID: "c-acme", Name: "Acme" },
          Date: "2026-07-10",
          Reference: "OTHER",
          LineItems: [
            { Description: "Different", Quantity: 1, UnitAmount: 1500 },
          ],
          Total: 1500,
          AmountDue: 1500,
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      now: () => new Date("2026-07-15T00:00:00Z"),
    });
    const config = { configurable: { thread_id: "inv-noref" } };
    const paused: any = await graph.invoke(
      {
        threadId: "inv-noref",
        tenantId: "tenant-1",
        userMessage: "invoice Acme 10 hours at 150",
      },
      config,
    );
    // Customer + amount match, but reference and line signature do not.
    expect(xeroTool.invoiceQueries).toHaveLength(1);
    expect(xeroTool.created).toHaveLength(1);
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
  });

  it("creates an ACCPAY bill for a supplier expense", async () => {
    const { graph, xeroTool } = buildGraph({
      intents: [intent({ docType: "bill", contactName: "Supplier Co" })],
      contacts: [{ ContactID: "c-sup", Name: "Supplier Co" }],
    });
    const config = { configurable: { thread_id: "inv-bill" } };

    const paused: any = await graph.invoke(
      {
        threadId: "inv-bill",
        tenantId: "tenant-1",
        userMessage: "bill from Supplier Co 10 x 150",
      },
      config,
    );
    expect(xeroTool.created[0].Type).toBe("ACCPAY");
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      config,
    );
    expect(resumed.result.completedApproval.name).toBe("xero_authorise_bill");
  });

  it("amends a DRAFT sales invoice in place only after approval", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
      invoices: [
        {
          InvoiceID: "i-draft",
          InvoiceNumber: "INV-DRAFT",
          Type: "ACCREC",
          Status: "DRAFT",
          Contact: { ContactID: "c-acme", Name: "Acme" },
          LineItems: [{ Description: "Old", Quantity: 1, UnitAmount: 100 }],
          Total: 100,
          AmountDue: 100,
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      intents: [
        intent({
          action: "amend_invoice",
          contactName: null,
          targetInvoiceRef: "INV-DRAFT",
          lineItems: [{ description: "New", quantity: 2, unitAmount: 150 }],
        }),
      ],
    });
    const config = { configurable: { thread_id: "inv-amend-draft" } };

    const paused: any = await graph.invoke(
      {
        threadId: "inv-amend-draft",
        tenantId: "tenant-1",
        userMessage: "change INV-DRAFT to 2 New at 150",
      },
      config,
    );

    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    expect(paused.__interrupt__?.[0]?.value?.approval.name).toBe(
      "xero_amend_invoice",
    );
    expect(xeroTool.updatedInvoices).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      config,
    );
    expect(resumed.result.status).toBe("amended");
    expect(xeroTool.updatedInvoices).toHaveLength(1);
    expect(xeroTool.updatedInvoices[0].InvoiceID).toBe("i-draft");
    expect(xeroTool.updatedInvoices[0].LineItems?.[0].Description).toBe("New");
    expect(resumed.result.completedApproval.name).toBe("xero_amend_invoice");
  });

  it("amends an AUTHORISED unpaid sales invoice in place only after approval", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
      invoices: [
        {
          InvoiceID: "i-auth",
          InvoiceNumber: "INV-AUTH",
          Type: "ACCREC",
          Status: "AUTHORISED",
          Contact: { ContactID: "c-acme", Name: "Acme" },
          LineItems: [{ Description: "Old", Quantity: 1, UnitAmount: 100 }],
          Total: 100,
          AmountDue: 100,
          AmountPaid: 0,
          AmountCredited: 0,
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      intents: [
        intent({
          action: "amend_invoice",
          contactName: null,
          targetInvoiceRef: "INV-AUTH",
          dueDate: "2026-08-20",
          lineItems: [{ description: "Updated", quantity: 1, unitAmount: 125 }],
        }),
      ],
    });
    const config = { configurable: { thread_id: "inv-amend-auth" } };

    await graph.invoke(
      {
        threadId: "inv-amend-auth",
        tenantId: "tenant-1",
        userMessage: "amend INV-AUTH due 2026-08-20 total 125",
      },
      config,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      config,
    );

    expect(resumed.result.status).toBe("amended");
    expect(xeroTool.updatedInvoices).toHaveLength(1);
    expect(xeroTool.createdCreditNotes).toHaveLength(0);
    expect(xeroTool.created).toHaveLength(0);
  });

  it("corrects a PAID sales invoice with credit note + replacement only after approval", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
      invoices: [
        {
          InvoiceID: "i-paid",
          InvoiceNumber: "INV-PAID",
          Type: "ACCREC",
          Status: "PAID",
          Contact: { ContactID: "c-acme", Name: "Acme" },
          CurrencyCode: "USD",
          LineItems: [{ Description: "Old", Quantity: 1, UnitAmount: 100 }],
          Total: 100,
          AmountDue: 0,
          AmountPaid: 100,
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      intents: [
        intent({
          action: "amend_invoice",
          contactName: null,
          targetInvoiceRef: "INV-PAID",
          lineItems: [
            { description: "Corrected", quantity: 1, unitAmount: 120 },
          ],
        }),
      ],
    });
    const config = { configurable: { thread_id: "inv-amend-paid" } };

    await graph.invoke(
      {
        threadId: "inv-amend-paid",
        tenantId: "tenant-1",
        userMessage: "amend paid invoice INV-PAID to 120",
      },
      config,
    );
    expect(xeroTool.createdCreditNotes).toHaveLength(0);
    expect(xeroTool.created).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: true } }),
      config,
    );
    expect(resumed.result.status).toBe("corrected");
    expect(xeroTool.updatedInvoices).toHaveLength(0);
    expect(xeroTool.createdCreditNotes).toHaveLength(1);
    expect(xeroTool.createdCreditNotes[0].Status).toBe("AUTHORISED");
    expect(xeroTool.created).toHaveLength(1);
    expect(xeroTool.created[0].Status).toBe("AUTHORISED");
    expect(resumed.result.completedApproval.items).toHaveLength(2);
  });

  it("rejecting an amendment writes nothing", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
      invoices: [
        {
          InvoiceID: "i-reject",
          InvoiceNumber: "INV-REJECT",
          Type: "ACCREC",
          Status: "DRAFT",
          Contact: { ContactID: "c-acme", Name: "Acme" },
          LineItems: [{ Description: "Old", Quantity: 1, UnitAmount: 100 }],
          Total: 100,
          AmountDue: 100,
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      intents: [
        intent({
          action: "amend_invoice",
          contactName: null,
          targetInvoiceRef: "INV-REJECT",
          lineItems: [{ description: "New", quantity: 1, unitAmount: 200 }],
        }),
      ],
    });
    const config = { configurable: { thread_id: "inv-amend-reject" } };

    await graph.invoke(
      {
        threadId: "inv-amend-reject",
        tenantId: "tenant-1",
        userMessage: "amend INV-REJECT",
      },
      config,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { approved: false } }),
      config,
    );

    expect(resumed.result.status).toBe("rejected");
    expect(xeroTool.updatedInvoices).toHaveLength(0);
    expect(xeroTool.createdCreditNotes).toHaveLength(0);
    expect(xeroTool.created).toHaveLength(0);
  });

  it("fails closed when amending a VOIDED invoice", async () => {
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
      invoices: [
        {
          InvoiceID: "i-void",
          InvoiceNumber: "INV-VOID",
          Type: "ACCREC",
          Status: "VOIDED",
          Contact: { ContactID: "c-acme", Name: "Acme" },
          LineItems: [{ Description: "Old", Quantity: 1, UnitAmount: 100 }],
          Total: 100,
          AmountDue: 0,
        },
      ],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      intents: [
        intent({
          action: "amend_invoice",
          contactName: null,
          targetInvoiceRef: "INV-VOID",
          lineItems: [{ description: "New", quantity: 1, unitAmount: 200 }],
        }),
      ],
    });

    const result: any = await graph.invoke(
      {
        threadId: "inv-amend-void",
        tenantId: "tenant-1",
        userMessage: "amend voided invoice INV-VOID",
      },
      { configurable: { thread_id: "inv-amend-void" } },
    );

    expect(result.result.status).toBe("failed");
    expect(result.__interrupt__).toBeUndefined();
    expect(xeroTool.updatedInvoices).toHaveLength(0);
    expect(xeroTool.createdCreditNotes).toHaveLength(0);
    expect(xeroTool.created).toHaveLength(0);
  });

  it("uses customer terms, AR balance, and FX variance in create approval preview", async () => {
    const seed: StubXeroSeed = {
      contacts: [
        {
          ContactID: "c-acme",
          Name: "Acme",
          PaymentTerms: { Sales: { Day: 30, Type: "DAYSAFTERBILLDATE" } },
          Balances: { AccountsReceivable: { Outstanding: 750 } },
        },
      ],
      organisation: { Name: "Stub Org", BaseCurrency: "SGD" },
      currencyRates: {
        "USD:2026-07-15": {
          currency: "USD",
          date: "2026-07-15",
          rate: 1,
          source: "xero",
          timestamp: "2026-07-15T00:00:00Z",
        },
      },
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      now: () => new Date("2026-07-15T00:00:00Z"),
      intents: [
        intent({
          date: "2026-07-15",
          currencyCode: "USD",
          quotedFxRate: 1.2,
        }),
      ],
    });

    const paused: any = await graph.invoke(
      {
        threadId: "inv-fx-terms",
        tenantId: "tenant-1",
        userMessage: "invoice Acme USD 1500 dated 2026-07-15 quoted FX 1.2",
      },
      { configurable: { thread_id: "inv-fx-terms" } },
    );

    expect(xeroTool.created[0].DueDate).toBe("2026-08-14");
    expect(xeroTool.currencyRateQueries).toEqual([
      { currency: "USD", date: "2026-07-15" },
    ]);
    const message = paused.__interrupt__?.[0]?.value?.message;
    expect(message).toContain("Customer AR balance: 750");
    expect(message).toContain("FX variance warning");
  });

  it("uses a saved retainer only when the invoice intent asks for it", async () => {
    const retainers = new InMemoryInvoiceRetainersTool();
    await retainers.upsert({
      tenantId: "tenant-1",
      contactName: "Acme",
      name: "monthly support",
      amount: 500,
      currencyCode: "USD",
      description: "Monthly support",
    });
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      invoiceRetainersTool: retainers,
      intents: [
        intent({
          useRetainer: true,
          retainerName: "monthly support",
          lineItems: [],
        }),
      ],
    });

    const paused: any = await graph.invoke(
      {
        threadId: "inv-retainer-use",
        tenantId: "tenant-1",
        userMessage: "create the monthly support retainer invoice for Acme",
      },
      { configurable: { thread_id: "inv-retainer-use" } },
    );

    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("approval");
    expect(xeroTool.created[0].LineItems[0]).toMatchObject({
      Description: "Monthly support",
      Quantity: 1,
      UnitAmount: 500,
    });
    expect(xeroTool.created[0].CurrencyCode).toBe("USD");
  });

  it("does not add a saved retainer to a plain invoice for the same customer", async () => {
    const retainers = new InMemoryInvoiceRetainersTool();
    await retainers.upsert({
      tenantId: "tenant-1",
      contactName: "Acme",
      name: "monthly support",
      amount: 500,
      currencyCode: "USD",
      description: "Monthly support",
    });
    const seed: StubXeroSeed = {
      contacts: [{ ContactID: "c-acme", Name: "Acme" }],
    };
    const { graph, xeroTool } = buildGraph({
      seed,
      invoiceRetainersTool: retainers,
    });

    await graph.invoke(
      {
        threadId: "inv-retainer-skip",
        tenantId: "tenant-1",
        userMessage: "invoice Acme 10 hours at 150",
      },
      { configurable: { thread_id: "inv-retainer-skip" } },
    );

    expect(xeroTool.created[0].LineItems).toHaveLength(1);
    expect(xeroTool.created[0].LineItems[0].Description).toBe("Consulting");
  });
});
