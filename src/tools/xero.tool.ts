/**
 * Xero Accounting API tool — a focused port of Agent's `extensions/xero/src/xero-client.ts`
 * and the contact/invoice tools. Pure Xero I/O; line-default logic lives in `commons/xero.ts`.
 */
import type { ILogger } from "@/commons";
import type { XeroAuth } from "@/services/xero-auth";

export interface XeroLineItem {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode?: string;
  TaxType?: string;
  ItemCode?: string;
}

export type InvoiceType = "ACCREC" | "ACCPAY";

export interface XeroInvoiceInput {
  Type: InvoiceType;
  Contact: { ContactID: string };
  LineItems: XeroLineItem[];
  Status?: "DRAFT" | "AUTHORISED";
  Reference?: string;
  Date?: string;
  DueDate?: string;
  CurrencyCode?: string;
}

export interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  CurrencyCode?: string;
}

export interface XeroContact {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
}

export interface XeroAccount {
  Code?: string;
  Name?: string;
  Type?: string;
  Status?: string;
  /** The account's default tax type — the only tax valid for lines posted to this account. */
  TaxType?: string;
}

export interface XeroTaxRate {
  TaxType?: string;
  EffectiveRate?: number;
  DisplayTaxRate?: number;
  Status?: string;
}

export interface IXeroTool {
  findContact(auth: XeroAuth, query: string): Promise<XeroContact[]>;
  upsertContact(
    auth: XeroAuth,
    contact: { name: string; email?: string },
  ): Promise<string>;
  createInvoices(
    auth: XeroAuth,
    invoices: XeroInvoiceInput[],
  ): Promise<XeroInvoice[]>;
  authoriseInvoice(auth: XeroAuth, invoiceId: string): Promise<XeroInvoice>;
  attachToInvoice(
    auth: XeroAuth,
    invoiceId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  getAccounts(auth: XeroAuth): Promise<XeroAccount[]>;
  getTaxRates(auth: XeroAuth): Promise<XeroTaxRate[]>;
}

const REFERENCE_TTL_MS = 30 * 60_000;

export class XeroTool implements IXeroTool {
  // Per-tenant reference cache (accounts / tax rates).
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly logger: ILogger) {}

  private async request<T = unknown>(
    auth: XeroAuth,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${auth.apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        "xero-tenant-id": auth.xeroTenantId,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST"
        ? { body: body ? JSON.stringify(body) : undefined }
        : {}),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `xero ${method} ${path} ${res.status}: ${extractXeroError(text)}`,
      );
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return { raw: text } as T;
    }
  }

  private async cached<T>(
    auth: XeroAuth,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const k = `${auth.xeroTenantId}:${key}`;
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.at < REFERENCE_TTL_MS) return hit.value as T;
    const value = await fetcher();
    this.cache.set(k, { at: Date.now(), value });
    return value;
  }

  async findContact(auth: XeroAuth, query: string): Promise<XeroContact[]> {
    const where = encodeURIComponent(
      `Name.Contains("${query.replace(/"/g, "")}")`,
    );
    const data = await this.request<{ Contacts?: XeroContact[] }>(
      auth,
      "GET",
      `/Contacts?where=${where}`,
    );
    return data.Contacts ?? [];
  }

  async upsertContact(
    auth: XeroAuth,
    contact: { name: string; email?: string },
  ): Promise<string> {
    const body = {
      Contacts: [
        {
          Name: contact.name,
          ...(contact.email ? { EmailAddress: contact.email } : {}),
        },
      ],
    };
    const data = await this.request<{ Contacts?: XeroContact[] }>(
      auth,
      "POST",
      "/Contacts",
      body,
    );
    const id = data.Contacts?.[0]?.ContactID;
    if (!id) throw new Error("xero upsertContact returned no ContactID");
    return id;
  }

  async createInvoices(
    auth: XeroAuth,
    invoices: XeroInvoiceInput[],
  ): Promise<XeroInvoice[]> {
    const data = await this.request<{ Invoices?: XeroInvoice[] }>(
      auth,
      "POST",
      "/Invoices",
      { Invoices: invoices },
    );
    return data.Invoices ?? [];
  }

  async authoriseInvoice(
    auth: XeroAuth,
    invoiceId: string,
  ): Promise<XeroInvoice> {
    const data = await this.request<{ Invoices?: XeroInvoice[] }>(
      auth,
      "POST",
      "/Invoices",
      {
        Invoices: [{ InvoiceID: invoiceId, Status: "AUTHORISED" }],
      },
    );
    const inv = data.Invoices?.[0];
    if (!inv) throw new Error("xero authoriseInvoice returned no invoice");
    return inv;
  }

  async attachToInvoice(
    auth: XeroAuth,
    invoiceId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    // Attachment upload uses a raw Blob body + the file's content type (not JSON).
    const path = `/Invoices/${invoiceId}/Attachments/${encodeURIComponent(fileName)}`;
    const res = await fetch(`${auth.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        "xero-tenant-id": auth.xeroTenantId,
        accept: "application/json",
        "content-type": contentType,
      },
      body: new Blob([bytes as BlobPart], { type: contentType }),
    });
    if (!res.ok) {
      throw new Error(
        `xero attach ${res.status}: ${extractXeroError(await res.text())}`,
      );
    }
    this.logger.info({ invoiceId, fileName }, "attached file to Xero invoice");
  }

  async getAccounts(auth: XeroAuth): Promise<XeroAccount[]> {
    return this.cached(auth, "accounts", async () => {
      const data = await this.request<{ Accounts?: XeroAccount[] }>(
        auth,
        "GET",
        "/Accounts",
      );
      return data.Accounts ?? [];
    });
  }

  async getTaxRates(auth: XeroAuth): Promise<XeroTaxRate[]> {
    return this.cached(auth, "taxrates", async () => {
      const data = await this.request<{ TaxRates?: XeroTaxRate[] }>(
        auth,
        "GET",
        "/TaxRates",
      );
      return data.TaxRates ?? [];
    });
  }
}

/** Pull Xero's nested ValidationErrors so the failure reason is legible. */
function extractXeroError(text: string): string {
  try {
    const j = JSON.parse(text) as {
      Message?: string;
      Elements?: {
        ValidationErrors?: { Message?: string }[];
        LineItems?: { ValidationErrors?: { Message?: string }[] }[];
      }[];
    };
    const msgs: string[] = [];
    for (const el of j.Elements ?? []) {
      for (const ve of el.ValidationErrors ?? [])
        if (ve.Message) msgs.push(ve.Message);
      for (const li of el.LineItems ?? [])
        for (const ve of li.ValidationErrors ?? [])
          if (ve.Message) msgs.push(ve.Message);
    }
    if (msgs.length) return [...new Set(msgs)].join("; ");
    if (j.Message) return j.Message;
  } catch {
    // non-JSON body
  }
  return text.slice(0, 300);
}

/** Offline stub for Studio / tests. Records writes so tests can assert draft/authorise. */
export class StubXeroTool implements IXeroTool {
  readonly created: XeroInvoiceInput[] = [];
  readonly authorised: string[] = [];
  readonly upserted: { name: string; email?: string }[] = [];
  readonly attached: { invoiceId: string; fileName: string }[] = [];

  constructor(private readonly contacts: XeroContact[] = []) {}

  async findContact(_auth: XeroAuth, query: string): Promise<XeroContact[]> {
    const q = query.toLowerCase();
    return this.contacts.filter((c) => c.Name.toLowerCase().includes(q));
  }

  async upsertContact(
    _auth: XeroAuth,
    contact: { name: string; email?: string },
  ): Promise<string> {
    this.upserted.push(contact);
    const id = `contact_${this.contacts.length + this.upserted.length}`;
    this.contacts.push({
      ContactID: id,
      Name: contact.name,
      EmailAddress: contact.email,
    });
    return id;
  }

  async createInvoices(
    _auth: XeroAuth,
    invoices: XeroInvoiceInput[],
  ): Promise<XeroInvoice[]> {
    this.created.push(...invoices);
    return invoices.map((inv, i) => ({
      InvoiceID: `inv_${this.created.length}_${i}`,
      Type: inv.Type,
      Status: inv.Status ?? "DRAFT",
      CurrencyCode: inv.CurrencyCode,
    }));
  }

  async authoriseInvoice(
    _auth: XeroAuth,
    invoiceId: string,
  ): Promise<XeroInvoice> {
    this.authorised.push(invoiceId);
    return { InvoiceID: invoiceId, Status: "AUTHORISED" };
  }

  async attachToInvoice(
    _auth: XeroAuth,
    invoiceId: string,
    fileName: string,
  ): Promise<void> {
    this.attached.push({ invoiceId, fileName });
  }

  async getAccounts(): Promise<XeroAccount[]> {
    return [
      { Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT" },
      { Code: "400", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE", TaxType: "INPUT" },
    ];
  }

  async getTaxRates(): Promise<XeroTaxRate[]> {
    return [{ TaxType: "NONE", EffectiveRate: 0, Status: "ACTIVE" }];
  }
}

export function createXeroTool(logger: ILogger): IXeroTool {
  return new XeroTool(logger);
}
