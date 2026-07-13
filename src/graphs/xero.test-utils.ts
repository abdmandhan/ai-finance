/**
 * Shared fixtures for the Xero graph test files and the live-LLM eval harness
 * (`evals/`): fake auth and seeded-document factories. Mirrors the role of
 * `schedule.test-utils.ts` for the scheduling suite.
 */
import type { XeroAuth } from "@/services/xero-auth";
import type { StubXeroSeed, XeroInvoiceDetail } from "@/tools";

export const fakeXeroAuth: XeroAuth = {
  accessToken: "x",
  xeroTenantId: "t",
  apiBaseUrl: "https://api.xero.com/api.xro/2.0",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

/** An open (AUTHORISED, unpaid) supplier bill. */
export function openBill(
  over: Partial<XeroInvoiceDetail> = {},
): XeroInvoiceDetail {
  return {
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
    ...over,
  };
}

/** An open (AUTHORISED, unpaid) customer sales invoice. */
export function openSalesInvoice(
  over: Partial<XeroInvoiceDetail> = {},
): XeroInvoiceDetail {
  return {
    InvoiceID: "i-200",
    InvoiceNumber: "INV-200",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: { ContactID: "c-acme", Name: "Acme" },
    Date: "2026-07-01",
    DueDate: "2026-08-01",
    Total: 1000,
    AmountDue: 1000,
    AmountPaid: 0,
    ...over,
  };
}

/** Baseline seed: known contacts, one open bill + one open invoice, one bank account. */
export function baseSeed(over: Partial<StubXeroSeed> = {}): StubXeroSeed {
  return {
    contacts: [
      { ContactID: "c-sup", Name: "Supplier Co" },
      { ContactID: "c-acme", Name: "Acme Ltd" },
    ],
    invoices: [openBill(), openSalesInvoice()],
    accounts: [
      { Code: "090", Name: "Business Bank Account", Type: "BANK", Status: "ACTIVE" },
      { Code: "091", Name: "BCA Checking", Type: "BANK", Status: "ACTIVE" },
      { Code: "200", Name: "Sales", Type: "REVENUE", Status: "ACTIVE", TaxType: "OUTPUT" },
      { Code: "400", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE", TaxType: "INPUT" },
    ],
    ...over,
  };
}
