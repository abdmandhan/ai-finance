/**
 * Xero Accounting API tool — a focused port of Agent's `extensions/xero/src/xero-client.ts`
 * and the contact/invoice tools. Pure Xero I/O; line-default logic lives in `commons/xero.ts`.
 */
import type { ILogger } from "@/commons";
import { buildInvoiceWhere, buildPaymentWhere } from "@/commons/xero-query";
import type { IProcessLogService } from "@/services/process-log.service";
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
  InvoiceID?: string;
  Type: InvoiceType;
  Contact: { ContactID: string };
  LineItems: XeroLineItem[];
  Status?: "DRAFT" | "AUTHORISED";
  Reference?: string;
  Date?: string;
  DueDate?: string;
  CurrencyCode?: string;
  /** Whether line UnitAmounts include tax. Inclusive → Xero back-computes GST. */
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
}

export interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  CurrencyCode?: string;
}

/** Fuller invoice shape returned by queries (list/detail reads). */
export interface XeroInvoiceDetail extends XeroInvoice {
  Contact?: { ContactID?: string; Name?: string };
  Date?: string;
  DueDate?: string;
  Reference?: string;
  AmountDue?: number;
  AmountPaid?: number;
  AmountCredited?: number;
  LineItems?: XeroLineItem[];
}

export interface XeroInvoiceUpdateInput {
  InvoiceID: string;
  Type?: InvoiceType;
  Contact?: { ContactID: string };
  LineItems?: XeroLineItem[];
  Status?: "DRAFT" | "AUTHORISED" | "VOIDED";
  Reference?: string;
  Date?: string;
  DueDate?: string;
  CurrencyCode?: string;
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
}

/**
 * Typed invoice query — `XeroTool` serializes it to a Xero `where` clause
 * (`buildInvoiceWhere`); `StubXeroTool` filters its seeded data directly.
 * Dates are YYYY-MM-DD.
 */
export interface InvoiceQuery {
  type?: InvoiceType;
  statuses?: string[];
  contactId?: string;
  invoiceNumber?: string;
  reference?: string;
  dueBefore?: string;
  dueAfter?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Only invoices with AmountDue > 0. */
  unpaidOnly?: boolean;
  amountDueMin?: number;
}

export interface XeroPaymentInput {
  Invoice: { InvoiceID?: string; InvoiceNumber?: string };
  Account: { AccountID?: string; Code?: string };
  Date: string;
  Amount: number;
  Reference?: string;
}

export interface XeroPayment {
  PaymentID: string;
  Status?: string;
  Amount?: number;
  Date?: string;
  Reference?: string;
  Invoice?: {
    InvoiceID?: string;
    InvoiceNumber?: string;
    Contact?: { Name?: string };
  };
}

export interface PaymentQuery {
  dateFrom?: string;
  dateTo?: string;
  reference?: string;
}

export type BankTransactionType = "SPEND" | "RECEIVE";

export interface XeroBankTransactionInput {
  Type: BankTransactionType;
  BankAccount: { AccountID?: string; Code?: string };
  Contact?: { ContactID: string };
  LineItems: XeroLineItem[];
  Date?: string;
  Reference?: string;
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
}

export interface XeroBankTransaction {
  BankTransactionID: string;
  Type?: string;
  Status?: string;
  Total?: number;
}

export interface XeroBankTransferInput {
  FromBankAccount: { AccountID?: string; Code?: string };
  ToBankAccount: { AccountID?: string; Code?: string };
  Amount: number;
  Date?: string;
}

export interface XeroBankTransfer {
  BankTransferID: string;
  Amount?: number;
  Date?: string;
}

export type CreditNoteType = "ACCRECCREDIT" | "ACCPAYCREDIT";

export interface XeroCreditNoteInput {
  Type: CreditNoteType;
  Contact: { ContactID: string };
  LineItems: XeroLineItem[];
  Date?: string;
  Reference?: string;
  CurrencyCode?: string;
  Status?: "DRAFT" | "AUTHORISED";
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
}

export interface XeroCreditNote {
  CreditNoteID: string;
  CreditNoteNumber?: string;
  Status?: string;
  Total?: number;
  RemainingCredit?: number;
}

export interface CreditNoteAllocation {
  InvoiceID: string;
  Amount: number;
  Date?: string;
}

export type XeroReportName =
  | "ProfitAndLoss"
  | "BalanceSheet"
  | "BankSummary"
  | "AgedReceivablesByContact"
  | "AgedPayablesByContact";

export interface XeroReportRow {
  RowType?: string;
  Title?: string;
  Cells?: { Value?: string | number }[];
  Rows?: XeroReportRow[];
}

export interface XeroReport {
  ReportName?: string;
  ReportTitles?: string[];
  Rows?: XeroReportRow[];
}

export interface XeroOrganisation {
  Name?: string;
  BaseCurrency?: string;
  Timezone?: string;
  CountryCode?: string;
}

export interface XeroContact {
  ContactID: string;
  Name: string;
  EmailAddress?: string;
  PaymentTerms?: {
    Sales?: { Day?: number; Type?: string };
    Bills?: { Day?: number; Type?: string };
  };
  Balances?: {
    AccountsReceivable?: { Outstanding?: number; Overdue?: number };
    AccountsPayable?: { Outstanding?: number; Overdue?: number };
  };
  ARBalance?: number;
  APBalance?: number;
}

export interface XeroCurrencyRate {
  currency: string;
  date: string;
  rate: number;
  source?: string;
  timestamp?: string;
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
  updateInvoice(
    auth: XeroAuth,
    invoice: XeroInvoiceUpdateInput,
  ): Promise<XeroInvoice>;
  authoriseInvoice(auth: XeroAuth, invoiceId: string): Promise<XeroInvoice>;
  updateInvoiceStatus(
    auth: XeroAuth,
    invoiceId: string,
    status: "AUTHORISED" | "VOIDED",
  ): Promise<XeroInvoice>;
  getInvoices(
    auth: XeroAuth,
    query: InvoiceQuery,
  ): Promise<XeroInvoiceDetail[]>;
  attachToInvoice(
    auth: XeroAuth,
    invoiceId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  attachToBankTransaction(
    auth: XeroAuth,
    bankTransactionId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  createPayments(
    auth: XeroAuth,
    payments: XeroPaymentInput[],
  ): Promise<XeroPayment[]>;
  getPayments(auth: XeroAuth, query: PaymentQuery): Promise<XeroPayment[]>;
  deletePayment(auth: XeroAuth, paymentId: string): Promise<void>;
  createCreditNotes(
    auth: XeroAuth,
    notes: XeroCreditNoteInput[],
  ): Promise<XeroCreditNote[]>;
  allocateCreditNote(
    auth: XeroAuth,
    creditNoteId: string,
    allocation: CreditNoteAllocation,
  ): Promise<void>;
  createBankTransactions(
    auth: XeroAuth,
    transactions: XeroBankTransactionInput[],
  ): Promise<XeroBankTransaction[]>;
  createBankTransfer(
    auth: XeroAuth,
    transfer: XeroBankTransferInput,
  ): Promise<XeroBankTransfer>;
  getReport(
    auth: XeroAuth,
    name: XeroReportName,
    params: Record<string, string>,
  ): Promise<XeroReport>;
  getOrganisation(auth: XeroAuth): Promise<XeroOrganisation>;
  getContact(auth: XeroAuth, contactId: string): Promise<XeroContact | null>;
  getCurrencyRate(
    auth: XeroAuth,
    currency: string,
    date: string,
  ): Promise<XeroCurrencyRate | null>;
  getAccounts(auth: XeroAuth): Promise<XeroAccount[]>;
  getTaxRates(auth: XeroAuth): Promise<XeroTaxRate[]>;
}

const REFERENCE_TTL_MS = 30 * 60_000;
const INVOICE_PAGE_SIZE = 100;
const MAX_INVOICE_PAGES = 10;

export class XeroTool implements IXeroTool {
  // Per-tenant reference cache (accounts / tax rates / organisation).
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly logger: ILogger,
    private readonly processLog?: IProcessLogService,
  ) {}

  private async request<T = unknown>(
    auth: XeroAuth,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const started = Date.now();
    const tool = `xero.${method} ${path.split("?")[0]}`;
    this.processLog?.log({
      event: "tool.call",
      stage: "xero.start",
      tool,
      payload: { method, path, body },
    });
    try {
      const res = await fetch(`${auth.apiBaseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "xero-tenant-id": auth.xeroTenantId,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(method !== "GET"
          ? { body: body ? JSON.stringify(body) : undefined }
          : {}),
      });
      const text = await res.text();
      if (!res.ok)
        throw new Error(
          `xero ${method} ${path} ${res.status}: ${extractXeroError(text)}`,
        );
      let parsed: T;
      try {
        parsed = (text ? JSON.parse(text) : {}) as T;
      } catch {
        parsed = { raw: text } as T;
      }
      this.processLog?.log({
        event: "tool.call",
        stage: "xero.end",
        tool,
        status: "ok",
        durationMs: Date.now() - started,
        payload: { method, path, statusCode: res.status, response: parsed },
      });
      return parsed;
    } catch (error) {
      this.processLog?.log({
        event: "tool.call",
        stage: "xero.error",
        tool,
        status: "error",
        durationMs: Date.now() - started,
        payload: { method, path, body },
        error,
      });
      throw error;
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

  async updateInvoice(
    auth: XeroAuth,
    invoice: XeroInvoiceUpdateInput,
  ): Promise<XeroInvoice> {
    const data = await this.request<{ Invoices?: XeroInvoice[] }>(
      auth,
      "POST",
      "/Invoices",
      { Invoices: [invoice] },
    );
    const inv = data.Invoices?.[0];
    if (!inv) throw new Error("xero updateInvoice returned no invoice");
    return inv;
  }

  async authoriseInvoice(
    auth: XeroAuth,
    invoiceId: string,
  ): Promise<XeroInvoice> {
    return this.updateInvoiceStatus(auth, invoiceId, "AUTHORISED");
  }

  async updateInvoiceStatus(
    auth: XeroAuth,
    invoiceId: string,
    status: "AUTHORISED" | "VOIDED",
  ): Promise<XeroInvoice> {
    const data = await this.request<{ Invoices?: XeroInvoice[] }>(
      auth,
      "POST",
      "/Invoices",
      {
        Invoices: [{ InvoiceID: invoiceId, Status: status }],
      },
    );
    const inv = data.Invoices?.[0];
    if (!inv)
      throw new Error(
        `xero updateInvoiceStatus(${status}) returned no invoice`,
      );
    return inv;
  }

  async getInvoices(
    auth: XeroAuth,
    query: InvoiceQuery,
  ): Promise<XeroInvoiceDetail[]> {
    const params: string[] = [];
    const where = buildInvoiceWhere(query);
    if (where) params.push(`where=${encodeURIComponent(where)}`);
    if (query.statuses?.length)
      params.push(`Statuses=${query.statuses.join(",")}`);

    const all: XeroInvoiceDetail[] = [];
    for (let page = 1; page <= MAX_INVOICE_PAGES; page++) {
      const qs = [...params, `page=${page}`].join("&");
      const data = await this.request<{ Invoices?: XeroInvoiceDetail[] }>(
        auth,
        "GET",
        `/Invoices?${qs}`,
      );
      const batch = data.Invoices ?? [];
      all.push(...batch);
      if (batch.length < INVOICE_PAGE_SIZE) break;
    }
    return all;
  }

  /** Attachment upload uses a raw Blob body + the file's content type (not JSON). */
  private async attach(
    auth: XeroAuth,
    entityPath: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const path = `${entityPath}/Attachments/${encodeURIComponent(fileName)}`;
    const started = Date.now();
    this.processLog?.log({
      event: "tool.call",
      stage: "xero.start",
      tool: "xero.attach",
      payload: { entityPath, fileName, contentType, byteLength: bytes.length },
    });
    try {
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
      this.processLog?.log({
        event: "tool.call",
        stage: "xero.end",
        tool: "xero.attach",
        status: "ok",
        durationMs: Date.now() - started,
        payload: {
          entityPath,
          fileName,
          contentType,
          byteLength: bytes.length,
        },
      });
    } catch (error) {
      this.processLog?.log({
        event: "tool.call",
        stage: "xero.error",
        tool: "xero.attach",
        status: "error",
        durationMs: Date.now() - started,
        payload: {
          entityPath,
          fileName,
          contentType,
          byteLength: bytes.length,
        },
        error,
      });
      throw error;
    }
  }

  async attachToInvoice(
    auth: XeroAuth,
    invoiceId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.attach(
      auth,
      `/Invoices/${invoiceId}`,
      fileName,
      bytes,
      contentType,
    );
    this.logger.info({ invoiceId, fileName }, "attached file to Xero invoice");
  }

  async attachToBankTransaction(
    auth: XeroAuth,
    bankTransactionId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.attach(
      auth,
      `/BankTransactions/${bankTransactionId}`,
      fileName,
      bytes,
      contentType,
    );
    this.logger.info(
      { bankTransactionId, fileName },
      "attached file to Xero bank transaction",
    );
  }

  async createPayments(
    auth: XeroAuth,
    payments: XeroPaymentInput[],
  ): Promise<XeroPayment[]> {
    const data = await this.request<{ Payments?: XeroPayment[] }>(
      auth,
      "PUT",
      "/Payments",
      { Payments: payments },
    );
    return data.Payments ?? [];
  }

  async getPayments(
    auth: XeroAuth,
    query: PaymentQuery,
  ): Promise<XeroPayment[]> {
    const where = buildPaymentWhere(query);
    const qs = where ? `?where=${encodeURIComponent(where)}` : "";
    const data = await this.request<{ Payments?: XeroPayment[] }>(
      auth,
      "GET",
      `/Payments${qs}`,
    );
    return data.Payments ?? [];
  }

  async deletePayment(auth: XeroAuth, paymentId: string): Promise<void> {
    await this.request(auth, "POST", `/Payments/${paymentId}`, {
      Status: "DELETED",
    });
    this.logger.info({ paymentId }, "deleted Xero payment");
  }

  async createCreditNotes(
    auth: XeroAuth,
    notes: XeroCreditNoteInput[],
  ): Promise<XeroCreditNote[]> {
    const data = await this.request<{ CreditNotes?: XeroCreditNote[] }>(
      auth,
      "PUT",
      "/CreditNotes",
      { CreditNotes: notes },
    );
    return data.CreditNotes ?? [];
  }

  async allocateCreditNote(
    auth: XeroAuth,
    creditNoteId: string,
    allocation: CreditNoteAllocation,
  ): Promise<void> {
    await this.request(
      auth,
      "PUT",
      `/CreditNotes/${creditNoteId}/Allocations`,
      {
        Allocations: [
          {
            Amount: allocation.Amount,
            Invoice: { InvoiceID: allocation.InvoiceID },
            ...(allocation.Date ? { Date: allocation.Date } : {}),
          },
        ],
      },
    );
    this.logger.info(
      { creditNoteId, invoiceId: allocation.InvoiceID },
      "allocated Xero credit note",
    );
  }

  async createBankTransactions(
    auth: XeroAuth,
    transactions: XeroBankTransactionInput[],
  ): Promise<XeroBankTransaction[]> {
    const data = await this.request<{
      BankTransactions?: XeroBankTransaction[];
    }>(auth, "PUT", "/BankTransactions", { BankTransactions: transactions });
    return data.BankTransactions ?? [];
  }

  async createBankTransfer(
    auth: XeroAuth,
    transfer: XeroBankTransferInput,
  ): Promise<XeroBankTransfer> {
    const data = await this.request<{ BankTransfers?: XeroBankTransfer[] }>(
      auth,
      "PUT",
      "/BankTransfers",
      { BankTransfers: [transfer] },
    );
    const t = data.BankTransfers?.[0];
    if (!t) throw new Error("xero createBankTransfer returned no transfer");
    return t;
  }

  async getReport(
    auth: XeroAuth,
    name: XeroReportName,
    params: Record<string, string>,
  ): Promise<XeroReport> {
    const qs = new URLSearchParams(params).toString();
    const data = await this.request<{ Reports?: XeroReport[] }>(
      auth,
      "GET",
      `/Reports/${name}${qs ? `?${qs}` : ""}`,
    );
    const report = data.Reports?.[0];
    if (!report) throw new Error(`xero getReport(${name}) returned no report`);
    return report;
  }

  async getOrganisation(auth: XeroAuth): Promise<XeroOrganisation> {
    return this.cached(auth, "organisation", async () => {
      const data = await this.request<{ Organisations?: XeroOrganisation[] }>(
        auth,
        "GET",
        "/Organisation",
      );
      const org = data.Organisations?.[0];
      if (!org)
        throw new Error("xero getOrganisation returned no organisation");
      return org;
    });
  }

  async getContact(
    auth: XeroAuth,
    contactId: string,
  ): Promise<XeroContact | null> {
    const data = await this.request<{ Contacts?: XeroContact[] }>(
      auth,
      "GET",
      `/Contacts/${encodeURIComponent(contactId)}`,
    );
    return data.Contacts?.[0] ?? null;
  }

  async getCurrencyRate(
    auth: XeroAuth,
    currency: string,
    date: string,
  ): Promise<XeroCurrencyRate | null> {
    const data = await this.request<{
      CurrencyRate?: number;
      Rate?: number;
      Currency?: string;
      Date?: string;
      Source?: string;
      Timestamp?: string;
    }>(
      auth,
      "GET",
      `/Currencies/${encodeURIComponent(currency)}/Rate?date=${encodeURIComponent(date)}`,
    );
    const rate = data.CurrencyRate ?? data.Rate;
    if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
    return {
      currency: data.Currency ?? currency,
      date: data.Date ?? date,
      rate,
      source: data.Source ?? "xero",
      timestamp: data.Timestamp ?? new Date().toISOString(),
    };
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
export function extractXeroError(text: string): string {
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

/** Seed data for `StubXeroTool` — everything optional; defaults are sensible. */
export interface StubXeroSeed {
  contacts?: XeroContact[];
  invoices?: XeroInvoiceDetail[];
  accounts?: XeroAccount[];
  taxRates?: XeroTaxRate[];
  currencyRates?: Record<string, XeroCurrencyRate>;
  payments?: XeroPayment[];
  reports?: Partial<Record<XeroReportName, XeroReport>>;
  organisation?: XeroOrganisation;
}

const STUB_DEFAULT_ACCOUNTS: XeroAccount[] = [
  {
    Code: "200",
    Name: "Sales",
    Type: "REVENUE",
    Status: "ACTIVE",
    TaxType: "OUTPUT",
  },
  {
    Code: "400",
    Name: "Expenses",
    Type: "EXPENSE",
    Status: "ACTIVE",
    TaxType: "INPUT",
  },
  {
    Code: "090",
    Name: "Business Bank Account",
    Type: "BANK",
    Status: "ACTIVE",
  },
  { Code: "091", Name: "Savings", Type: "BANK", Status: "ACTIVE" },
];

const STUB_DEFAULT_PNL: XeroReport = {
  ReportName: "ProfitAndLoss",
  Rows: [
    {
      RowType: "Section",
      Title: "Income",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "5000.00" }] },
        {
          RowType: "SummaryRow",
          Cells: [{ Value: "Total Income" }, { Value: "5000.00" }],
        },
      ],
    },
    {
      RowType: "Section",
      Title: "Less Operating Expenses",
      Rows: [
        {
          RowType: "Row",
          Cells: [{ Value: "Office Expenses" }, { Value: "3000.00" }],
        },
        {
          RowType: "SummaryRow",
          Cells: [{ Value: "Total Operating Expenses" }, { Value: "3000.00" }],
        },
      ],
    },
    {
      RowType: "Section",
      Title: "",
      Rows: [
        {
          RowType: "SummaryRow",
          Cells: [{ Value: "Net Profit" }, { Value: "2000.00" }],
        },
      ],
    },
  ],
};

/** Offline stub for Studio / tests. Records writes so tests can assert every operation. */
export class StubXeroTool implements IXeroTool {
  readonly created: XeroInvoiceInput[] = [];
  readonly updatedInvoices: XeroInvoiceUpdateInput[] = [];
  readonly authorised: string[] = [];
  readonly upserted: { name: string; email?: string }[] = [];
  readonly attached: { invoiceId: string; fileName: string }[] = [];
  readonly createdPayments: XeroPaymentInput[] = [];
  readonly deletedPayments: string[] = [];
  readonly createdCreditNotes: XeroCreditNoteInput[] = [];
  readonly allocations: {
    creditNoteId: string;
    invoiceId: string;
    amount: number;
  }[] = [];
  readonly bankTransactions: XeroBankTransactionInput[] = [];
  readonly bankTransfers: XeroBankTransferInput[] = [];
  readonly attachedToBankTransactions: {
    bankTransactionId: string;
    fileName: string;
  }[] = [];
  readonly reportRequests: {
    name: XeroReportName;
    params: Record<string, string>;
  }[] = [];
  readonly invoiceQueries: InvoiceQuery[] = [];
  readonly contactDetailQueries: string[] = [];
  readonly currencyRateQueries: { currency: string; date: string }[] = [];
  readonly statusUpdates: { invoiceId: string; status: string }[] = [];

  private readonly contacts: XeroContact[];
  private readonly invoices: XeroInvoiceDetail[];
  private readonly payments: XeroPayment[];
  private readonly seed: StubXeroSeed;

  constructor(seed: XeroContact[] | StubXeroSeed = []) {
    this.seed = Array.isArray(seed) ? { contacts: seed } : seed;
    this.contacts = [...(this.seed.contacts ?? [])];
    this.invoices = [...(this.seed.invoices ?? [])];
    this.payments = [...(this.seed.payments ?? [])];
  }

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
    return invoices.map((inv, i) => {
      const created: XeroInvoiceDetail = {
        InvoiceID: `inv_${this.created.length}_${i}`,
        Type: inv.Type,
        Status: inv.Status ?? "DRAFT",
        CurrencyCode: inv.CurrencyCode,
        Contact: inv.Contact,
        Reference: inv.Reference,
        Date: inv.Date,
        DueDate: inv.DueDate,
        LineItems: inv.LineItems,
        Total: inv.LineItems.reduce(
          (sum, l) => sum + l.Quantity * l.UnitAmount,
          0,
        ),
        AmountDue: inv.LineItems.reduce(
          (sum, l) => sum + l.Quantity * l.UnitAmount,
          0,
        ),
        AmountPaid: 0,
        AmountCredited: 0,
      };
      this.invoices.push(created);
      return created;
    });
  }

  async updateInvoice(
    _auth: XeroAuth,
    invoice: XeroInvoiceUpdateInput,
  ): Promise<XeroInvoice> {
    this.updatedInvoices.push(invoice);
    const seeded = this.invoices.find((i) => i.InvoiceID === invoice.InvoiceID);
    if (seeded) {
      Object.assign(seeded, {
        ...invoice,
        Type: invoice.Type ?? seeded.Type,
        Contact: invoice.Contact ?? seeded.Contact,
        LineItems: invoice.LineItems ?? seeded.LineItems,
        Status: invoice.Status ?? seeded.Status,
      });
      if (invoice.LineItems) {
        seeded.Total = invoice.LineItems.reduce(
          (sum, l) => sum + l.Quantity * l.UnitAmount,
          0,
        );
        seeded.AmountDue = seeded.Total - (seeded.AmountPaid ?? 0);
      }
    }
    return {
      InvoiceID: invoice.InvoiceID,
      Type: invoice.Type ?? seeded?.Type,
      Status: invoice.Status ?? seeded?.Status,
      CurrencyCode: invoice.CurrencyCode ?? seeded?.CurrencyCode,
    };
  }

  async authoriseInvoice(
    auth: XeroAuth,
    invoiceId: string,
  ): Promise<XeroInvoice> {
    this.authorised.push(invoiceId);
    return this.updateInvoiceStatus(auth, invoiceId, "AUTHORISED");
  }

  async updateInvoiceStatus(
    _auth: XeroAuth,
    invoiceId: string,
    status: "AUTHORISED" | "VOIDED",
  ): Promise<XeroInvoice> {
    this.statusUpdates.push({ invoiceId, status });
    const seeded = this.invoices.find((i) => i.InvoiceID === invoiceId);
    if (seeded) seeded.Status = status;
    return { InvoiceID: invoiceId, Status: status };
  }

  async getInvoices(
    _auth: XeroAuth,
    query: InvoiceQuery,
  ): Promise<XeroInvoiceDetail[]> {
    this.invoiceQueries.push(query);
    return this.invoices.filter((inv) => {
      if (query.type && inv.Type !== query.type) return false;
      if (query.statuses?.length && !query.statuses.includes(inv.Status ?? ""))
        return false;
      if (query.contactId && inv.Contact?.ContactID !== query.contactId)
        return false;
      if (
        query.invoiceNumber &&
        (inv.InvoiceNumber ?? "").toLowerCase() !==
          query.invoiceNumber.toLowerCase()
      )
        return false;
      if (
        query.reference &&
        (inv.Reference ?? "").toLowerCase() !== query.reference.toLowerCase()
      )
        return false;
      if (query.dueBefore && !((inv.DueDate ?? "") < query.dueBefore))
        return false;
      if (query.dueAfter && !((inv.DueDate ?? "") >= query.dueAfter))
        return false;
      if (query.dateFrom && !((inv.Date ?? "") >= query.dateFrom)) return false;
      if (query.dateTo && !((inv.Date ?? "") <= query.dateTo)) return false;
      if (query.unpaidOnly && (inv.AmountDue ?? 0) <= 0) return false;
      if (
        query.amountDueMin !== undefined &&
        (inv.AmountDue ?? 0) < query.amountDueMin
      )
        return false;
      return true;
    });
  }

  async attachToInvoice(
    _auth: XeroAuth,
    invoiceId: string,
    fileName: string,
  ): Promise<void> {
    this.attached.push({ invoiceId, fileName });
  }

  async attachToBankTransaction(
    _auth: XeroAuth,
    bankTransactionId: string,
    fileName: string,
  ): Promise<void> {
    this.attachedToBankTransactions.push({ bankTransactionId, fileName });
  }

  async createPayments(
    _auth: XeroAuth,
    payments: XeroPaymentInput[],
  ): Promise<XeroPayment[]> {
    this.createdPayments.push(...payments);
    return payments.map((p, i) => {
      // Reflect the payment on the seeded invoice so later queries see the new balance.
      const seeded = this.invoices.find(
        (inv) =>
          inv.InvoiceID === p.Invoice.InvoiceID ||
          (p.Invoice.InvoiceNumber &&
            inv.InvoiceNumber === p.Invoice.InvoiceNumber),
      );
      if (seeded) {
        seeded.AmountPaid = (seeded.AmountPaid ?? 0) + p.Amount;
        seeded.AmountDue = Math.max(0, (seeded.AmountDue ?? 0) - p.Amount);
        if (seeded.AmountDue === 0) seeded.Status = "PAID";
      }
      const payment: XeroPayment = {
        PaymentID: `pay_${this.createdPayments.length}_${i}`,
        Status: "AUTHORISED",
        Amount: p.Amount,
        Date: p.Date,
        Reference: p.Reference,
        Invoice: {
          InvoiceID: seeded?.InvoiceID ?? p.Invoice.InvoiceID,
          InvoiceNumber: seeded?.InvoiceNumber ?? p.Invoice.InvoiceNumber,
        },
      };
      this.payments.push(payment);
      return payment;
    });
  }

  async getPayments(
    _auth: XeroAuth,
    query: PaymentQuery,
  ): Promise<XeroPayment[]> {
    return this.payments.filter((p) => {
      if (p.Status === "DELETED") return false;
      if (query.dateFrom && !((p.Date ?? "") >= query.dateFrom)) return false;
      if (query.dateTo && !((p.Date ?? "") <= query.dateTo)) return false;
      if (
        query.reference &&
        (p.Reference ?? "").toLowerCase() !== query.reference.toLowerCase()
      )
        return false;
      return true;
    });
  }

  async deletePayment(_auth: XeroAuth, paymentId: string): Promise<void> {
    this.deletedPayments.push(paymentId);
    const seeded = this.payments.find((p) => p.PaymentID === paymentId);
    if (seeded) seeded.Status = "DELETED";
  }

  async createCreditNotes(
    _auth: XeroAuth,
    notes: XeroCreditNoteInput[],
  ): Promise<XeroCreditNote[]> {
    this.createdCreditNotes.push(...notes);
    return notes.map((n, i) => {
      const total = n.LineItems.reduce(
        (sum, l) => sum + l.Quantity * l.UnitAmount,
        0,
      );
      return {
        CreditNoteID: `cn_${this.createdCreditNotes.length}_${i}`,
        CreditNoteNumber: `CN-${this.createdCreditNotes.length}${i}`,
        Status: n.Status ?? "DRAFT",
        Total: total,
        RemainingCredit: total,
      };
    });
  }

  async allocateCreditNote(
    _auth: XeroAuth,
    creditNoteId: string,
    allocation: CreditNoteAllocation,
  ): Promise<void> {
    this.allocations.push({
      creditNoteId,
      invoiceId: allocation.InvoiceID,
      amount: allocation.Amount,
    });
    const seeded = this.invoices.find(
      (inv) => inv.InvoiceID === allocation.InvoiceID,
    );
    if (seeded) {
      seeded.AmountCredited = (seeded.AmountCredited ?? 0) + allocation.Amount;
      seeded.AmountDue = Math.max(
        0,
        (seeded.AmountDue ?? 0) - allocation.Amount,
      );
    }
  }

  async createBankTransactions(
    _auth: XeroAuth,
    transactions: XeroBankTransactionInput[],
  ): Promise<XeroBankTransaction[]> {
    this.bankTransactions.push(...transactions);
    return transactions.map((t, i) => ({
      BankTransactionID: `bt_${this.bankTransactions.length}_${i}`,
      Type: t.Type,
      Status: "AUTHORISED",
      Total: t.LineItems.reduce((sum, l) => sum + l.Quantity * l.UnitAmount, 0),
    }));
  }

  async createBankTransfer(
    _auth: XeroAuth,
    transfer: XeroBankTransferInput,
  ): Promise<XeroBankTransfer> {
    this.bankTransfers.push(transfer);
    return {
      BankTransferID: `xfer_${this.bankTransfers.length}`,
      Amount: transfer.Amount,
      Date: transfer.Date,
    };
  }

  async getReport(
    _auth: XeroAuth,
    name: XeroReportName,
    params: Record<string, string>,
  ): Promise<XeroReport> {
    this.reportRequests.push({ name, params });
    const seeded = this.seed.reports?.[name];
    if (seeded) return seeded;
    if (name === "ProfitAndLoss") return STUB_DEFAULT_PNL;
    return { ReportName: name, Rows: [] };
  }

  async getOrganisation(): Promise<XeroOrganisation> {
    return (
      this.seed.organisation ?? {
        Name: "Stub Org",
        BaseCurrency: "SGD",
        Timezone: "Asia/Singapore",
      }
    );
  }

  async getContact(
    _auth: XeroAuth,
    contactId: string,
  ): Promise<XeroContact | null> {
    this.contactDetailQueries.push(contactId);
    return this.contacts.find((c) => c.ContactID === contactId) ?? null;
  }

  async getCurrencyRate(
    _auth: XeroAuth,
    currency: string,
    date: string,
  ): Promise<XeroCurrencyRate | null> {
    this.currencyRateQueries.push({ currency, date });
    const key = `${currency}:${date}`;
    const rate =
      this.seed.currencyRates?.[key] ?? this.seed.currencyRates?.[currency];
    return rate ?? null;
  }

  async getAccounts(): Promise<XeroAccount[]> {
    return this.seed.accounts ?? STUB_DEFAULT_ACCOUNTS;
  }

  async getTaxRates(): Promise<XeroTaxRate[]> {
    return (
      this.seed.taxRates ?? [
        { TaxType: "NONE", EffectiveRate: 0, Status: "ACTIVE" },
        { TaxType: "GST9", EffectiveRate: 9, Status: "ACTIVE" },
      ]
    );
  }
}

export function createXeroTool(
  logger: ILogger,
  processLog?: IProcessLogService,
): IXeroTool {
  return new XeroTool(logger, processLog);
}
