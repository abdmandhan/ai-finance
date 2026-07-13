import { describe, expect, it } from "vitest";
import type { XeroAuth } from "@/services/xero-auth";
import {
  extractXeroError,
  StubXeroTool,
  type StubXeroSeed,
  type XeroInvoiceDetail,
} from "./xero.tool";

const auth: XeroAuth = {
  accessToken: "x",
  xeroTenantId: "t",
  apiBaseUrl: "https://api.xero.com/api.xro/2.0",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

const INVOICES: XeroInvoiceDetail[] = [
  {
    InvoiceID: "i-100",
    InvoiceNumber: "INV-100",
    Type: "ACCPAY",
    Status: "AUTHORISED",
    Contact: { ContactID: "c-1", Name: "Supplier Co" },
    Date: "2026-06-15",
    DueDate: "2026-07-01",
    Total: 500,
    AmountDue: 500,
    AmountPaid: 0,
  },
  {
    InvoiceID: "i-200",
    InvoiceNumber: "INV-200",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: { ContactID: "c-2", Name: "Acme" },
    Date: "2026-07-01",
    DueDate: "2026-08-01",
    Total: 1000,
    AmountDue: 1000,
    AmountPaid: 0,
  },
  {
    InvoiceID: "i-300",
    InvoiceNumber: "INV-300",
    Type: "ACCPAY",
    Status: "PAID",
    Contact: { ContactID: "c-1", Name: "Supplier Co" },
    Date: "2026-05-01",
    DueDate: "2026-06-01",
    Total: 250,
    AmountDue: 0,
    AmountPaid: 250,
  },
];

function seeded(extra: Partial<StubXeroSeed> = {}) {
  return new StubXeroTool({
    contacts: [{ ContactID: "c-1", Name: "Supplier Co" }],
    invoices: INVOICES.map((i) => ({ ...i })),
    ...extra,
  });
}

describe("StubXeroTool seed back-compat", () => {
  it("still accepts a bare contact array", async () => {
    const stub = new StubXeroTool([{ ContactID: "c-9", Name: "Acme" }]);
    expect(await stub.findContact(auth, "acme")).toHaveLength(1);
    // Default accounts keep the original 200/400 pair and add bank accounts.
    const accounts = await stub.getAccounts();
    expect(accounts.map((a) => a.Code)).toEqual(["200", "400", "090", "091"]);
  });
});

describe("StubXeroTool.getInvoices", () => {
  it("filters by typed query fields and records the query", async () => {
    const stub = seeded();
    const overdue = await stub.getInvoices(auth, {
      type: "ACCPAY",
      unpaidOnly: true,
      dueBefore: "2026-07-12",
    });
    // XERO-EXP-011: the PAID bill is excluded even though it is also past due.
    expect(overdue.map((i) => i.InvoiceNumber)).toEqual(["INV-100"]);
    expect(stub.invoiceQueries).toHaveLength(1);
    expect(stub.invoiceQueries[0].unpaidOnly).toBe(true);
  });

  it("filters by invoice number case-insensitively", async () => {
    const stub = seeded();
    const hits = await stub.getInvoices(auth, { invoiceNumber: "inv-200" });
    expect(hits).toHaveLength(1);
    expect(hits[0].InvoiceID).toBe("i-200");
  });

  it("filters by minimum amount due", async () => {
    const stub = seeded();
    const hits = await stub.getInvoices(auth, { amountDueMin: 600 });
    expect(hits.map((i) => i.InvoiceNumber)).toEqual(["INV-200"]);
  });
});

describe("StubXeroTool payments", () => {
  it("records payments and reflects them on the seeded invoice balance", async () => {
    const stub = seeded();
    const [payment] = await stub.createPayments(auth, [
      {
        Invoice: { InvoiceID: "i-200" },
        Account: { Code: "090" },
        Date: "2026-07-12",
        Amount: 400,
      },
    ]);
    expect(stub.createdPayments).toHaveLength(1);
    expect(payment.Status).toBe("AUTHORISED");

    // XERO-PAY-004: partial payment leaves the remaining balance.
    const [inv] = await stub.getInvoices(auth, { invoiceNumber: "INV-200" });
    expect(inv.AmountDue).toBe(600);
    expect(inv.AmountPaid).toBe(400);
    expect(inv.Status).toBe("AUTHORISED");
  });

  it("full payment marks the invoice PAID", async () => {
    const stub = seeded();
    await stub.createPayments(auth, [
      {
        Invoice: { InvoiceNumber: "INV-100" },
        Account: { Code: "090" },
        Date: "2026-07-12",
        Amount: 500,
      },
    ]);
    const [inv] = await stub.getInvoices(auth, { invoiceNumber: "INV-100" });
    expect(inv.Status).toBe("PAID");
    expect(inv.AmountDue).toBe(0);
  });

  it("deletePayment records the reversal and hides it from getPayments", async () => {
    const stub = seeded();
    const [payment] = await stub.createPayments(auth, [
      {
        Invoice: { InvoiceID: "i-200" },
        Account: { Code: "090" },
        Date: "2026-07-11",
        Amount: 100,
      },
    ]);
    await stub.deletePayment(auth, payment.PaymentID);
    expect(stub.deletedPayments).toEqual([payment.PaymentID]);
    expect(
      await stub.getPayments(auth, { dateFrom: "2026-07-11" }),
    ).toHaveLength(0);
  });
});

describe("StubXeroTool credit notes, bank transactions, transfers", () => {
  it("records credit notes and allocations, reducing the invoice balance", async () => {
    const stub = seeded();
    const [note] = await stub.createCreditNotes(auth, [
      {
        Type: "ACCRECCREDIT",
        Contact: { ContactID: "c-2" },
        LineItems: [{ Description: "Returned item", Quantity: 1, UnitAmount: 200 }],
      },
    ]);
    expect(note.RemainingCredit).toBe(200);

    await stub.allocateCreditNote(auth, note.CreditNoteID, {
      InvoiceID: "i-200",
      Amount: 200,
    });
    expect(stub.allocations).toEqual([
      { creditNoteId: note.CreditNoteID, invoiceId: "i-200", amount: 200 },
    ]);
    const [inv] = await stub.getInvoices(auth, { invoiceNumber: "INV-200" });
    expect(inv.AmountDue).toBe(800);
  });

  it("records bank transactions and attachments", async () => {
    const stub = seeded();
    const [txn] = await stub.createBankTransactions(auth, [
      {
        Type: "SPEND",
        BankAccount: { Code: "090" },
        LineItems: [{ Description: "Parking", Quantity: 1, UnitAmount: 20 }],
      },
    ]);
    expect(txn.Total).toBe(20);
    await stub.attachToBankTransaction(auth, txn.BankTransactionID, "receipt.jpg");
    expect(stub.attachedToBankTransactions).toEqual([
      { bankTransactionId: txn.BankTransactionID, fileName: "receipt.jpg" },
    ]);
  });

  it("records bank transfers", async () => {
    const stub = seeded();
    await stub.createBankTransfer(auth, {
      FromBankAccount: { Code: "090" },
      ToBankAccount: { Code: "091" },
      Amount: 1000,
    });
    expect(stub.bankTransfers).toHaveLength(1);
  });
});

describe("StubXeroTool reports, organisation, status updates", () => {
  it("records report requests and serves the seeded report", async () => {
    const stub = seeded({
      reports: { BalanceSheet: { ReportName: "BalanceSheet", Rows: [] } },
    });
    const report = await stub.getReport(auth, "BalanceSheet", {
      date: "2026-07-12",
    });
    expect(report.ReportName).toBe("BalanceSheet");
    expect(stub.reportRequests).toEqual([
      { name: "BalanceSheet", params: { date: "2026-07-12" } },
    ]);
  });

  it("serves a default P&L when none is seeded", async () => {
    const stub = seeded();
    const pnl = await stub.getReport(auth, "ProfitAndLoss", {});
    expect(pnl.Rows?.length).toBeGreaterThan(0);
  });

  it("returns the seeded organisation or a default", async () => {
    expect((await seeded().getOrganisation()).Timezone).toBe("Asia/Singapore");
    const custom = seeded({ organisation: { BaseCurrency: "IDR" } });
    expect((await custom.getOrganisation()).BaseCurrency).toBe("IDR");
  });

  it("XERO-INV-015: updateInvoiceStatus records voids and updates seeded state", async () => {
    const stub = seeded();
    await stub.updateInvoiceStatus(auth, "i-200", "VOIDED");
    expect(stub.statusUpdates).toEqual([{ invoiceId: "i-200", status: "VOIDED" }]);
    const hits = await stub.getInvoices(auth, { statuses: ["VOIDED"] });
    expect(hits.map((i) => i.InvoiceID)).toEqual(["i-200"]);
  });
});

describe("extractXeroError", () => {
  it("XERO-ERR-003: surfaces nested validation messages", () => {
    const body = JSON.stringify({
      Message: "A validation exception occurred",
      Elements: [
        {
          ValidationErrors: [{ Message: "Account code '999' is not valid" }],
          LineItems: [
            { ValidationErrors: [{ Message: "Description is required" }] },
          ],
        },
      ],
    });
    expect(extractXeroError(body)).toBe(
      "Account code '999' is not valid; Description is required",
    );
  });

  it("falls back to the top-level message, then raw text", () => {
    expect(extractXeroError(JSON.stringify({ Message: "Rate limited" }))).toBe(
      "Rate limited",
    );
    expect(extractXeroError("<html>boom</html>")).toBe("<html>boom</html>");
  });
});
