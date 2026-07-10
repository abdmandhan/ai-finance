import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { Command, MemorySaver } from "@langchain/langgraph";
import type { InvoiceIntent } from "@/schemas";
import type { ILlmService, XeroAuth } from "@/services";
import { StubXeroTool, type XeroContact } from "@/tools";
import type { InvoiceDeps } from "@/nodes";
import { buildInvoiceGraph } from "./invoice.graph";

function intent(over: Partial<InvoiceIntent> = {}): InvoiceIntent {
  return {
    docType: "sales",
    contactName: "Acme",
    lineItems: [{ description: "Consulting", quantity: 10, unitAmount: 150 }],
    reference: null,
    date: null,
    dueDate: null,
    currencyCode: null,
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
    withFetch?: boolean;
  } = {},
) {
  const logger = pino({ level: "silent" });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { extract };
  const xeroTool = new StubXeroTool(
    opts.contacts ?? [{ ContactID: "c-acme", Name: "Acme" }],
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
    ...(opts.withFetch ? { fetchAttachment } : {}),
    logger,
  };
  return { graph: buildInvoiceGraph(deps, new MemorySaver()), xeroTool, fetchAttachment };
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
          { url: "http://minio/a.jpg", mimeType: "image/jpeg", fileName: "a.jpg" },
          { url: "http://minio/b.jpg", mimeType: "image/jpeg", fileName: "b.jpg" },
        ],
      },
      config,
    );

    // Read one image per attachment for the vision model (2) + re-fetched per attach (2) = 4.
    expect(fetchAttachment).toHaveBeenCalled();
    expect(xeroTool.created).toHaveLength(1);
    expect(xeroTool.attached).toHaveLength(2);
    expect(xeroTool.attached.map((a) => a.fileName)).toEqual(["a.jpg", "b.jpg"]);
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
  });
});
