import { describe, expect, it } from "vitest";
import {
  bankAccountsOf,
  buildInvoiceWhere,
  buildPaymentWhere,
  flattenReportRows,
  matchAccountByHint,
  reportDataRows,
  reportSectionTotal,
} from "./xero-query";
import type { XeroAccount, XeroReport } from "@/tools";

describe("buildInvoiceWhere", () => {
  it("serializes every filter with Xero syntax", () => {
    const where = buildInvoiceWhere({
      type: "ACCPAY",
      contactId: "c-1",
      invoiceNumber: "INV-100",
      dueBefore: "2026-07-12",
      unpaidOnly: true,
      amountDueMin: 10_000_000,
    });
    expect(where).toBe(
      'Type == "ACCPAY" AND Contact.ContactID == Guid("c-1") AND ' +
        'InvoiceNumber == "INV-100" AND DueDate < DateTime(2026, 7, 12) AND ' +
        "AmountDue > 0 AND AmountDue >= 10000000",
    );
  });

  it("returns empty for an empty query", () => {
    expect(buildInvoiceWhere({})).toBe("");
  });

  it("strips embedded quotes from user-supplied strings", () => {
    expect(buildInvoiceWhere({ reference: 'x" OR 1==1' })).toBe(
      'Reference == "x OR 1==1"',
    );
  });
});

describe("buildPaymentWhere", () => {
  it("always excludes deleted payments and adds a date window", () => {
    expect(buildPaymentWhere({ dateFrom: "2026-07-11", dateTo: "2026-07-11" })).toBe(
      'Status == "AUTHORISED" AND Date >= DateTime(2026, 7, 11) AND Date <= DateTime(2026, 7, 11)',
    );
  });
});

const ACCOUNTS: XeroAccount[] = [
  { Code: "090", Name: "BCA Checking", Type: "BANK", Status: "ACTIVE" },
  { Code: "091", Name: "Savings", Type: "BANK", Status: "ACTIVE" },
  { Code: "092", Name: "Old Bank", Type: "BANK", Status: "ARCHIVED" },
  { Code: "400", Name: "Expenses", Type: "EXPENSE", Status: "ACTIVE" },
];

describe("bankAccountsOf", () => {
  it("returns only active BANK accounts", () => {
    expect(bankAccountsOf(ACCOUNTS).map((a) => a.Code)).toEqual(["090", "091"]);
  });
});

describe("matchAccountByHint", () => {
  it("matches exact code first", () => {
    expect(matchAccountByHint(ACCOUNTS, "091").map((a) => a.Name)).toEqual([
      "Savings",
    ]);
  });

  it("matches name containment case-insensitively in either direction", () => {
    expect(matchAccountByHint(ACCOUNTS, "bca").map((a) => a.Code)).toEqual([
      "090",
    ]);
    expect(
      matchAccountByHint(ACCOUNTS, "savings account").map((a) => a.Code),
    ).toEqual(["091"]);
  });

  it("XERO-ACC-003: never matches archived accounts", () => {
    expect(matchAccountByHint(ACCOUNTS, "old bank")).toEqual([]);
  });

  it("empty hint matches nothing", () => {
    expect(matchAccountByHint(ACCOUNTS, "  ")).toEqual([]);
  });
});

// Shape captured from a real Xero ProfitAndLoss response (values simplified).
const PNL: XeroReport = {
  ReportName: "ProfitAndLoss",
  Rows: [
    {
      RowType: "Header",
      Cells: [{ Value: "" }, { Value: "1 Jul 2026 to 31 Jul 2026" }],
    },
    {
      RowType: "Section",
      Title: "Income",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "5,250.00" }] },
        {
          RowType: "Row",
          Cells: [{ Value: "Consulting" }, { Value: "1,000.00" }],
        },
        {
          RowType: "SummaryRow",
          Cells: [{ Value: "Total Income" }, { Value: "6,250.00" }],
        },
      ],
    },
    {
      RowType: "Section",
      Title: "Less Operating Expenses",
      Rows: [
        {
          RowType: "Row",
          Cells: [{ Value: "Software" }, { Value: "2,000.00" }],
        },
        { RowType: "Row", Cells: [{ Value: "Rent" }, { Value: "1,500.00" }] },
        {
          RowType: "SummaryRow",
          Cells: [{ Value: "Total Operating Expenses" }, { Value: "3,500.00" }],
        },
      ],
    },
    {
      RowType: "Section",
      Title: "",
      Rows: [
        {
          RowType: "SummaryRow",
          Cells: [{ Value: "Net Profit" }, { Value: "2,750.00" }],
        },
      ],
    },
  ],
};

describe("report parsing", () => {
  it("flattenReportRows tags rows with their section", () => {
    const flat = flattenReportRows(PNL);
    const software = flat.find((r) => r.cells[0] === "Software");
    expect(software?.section).toBe("Less Operating Expenses");
  });

  it("reportSectionTotal finds section totals with comma-formatted numbers", () => {
    expect(reportSectionTotal(PNL, "income")).toBe(6250);
    expect(reportSectionTotal(PNL, "operating expenses")).toBe(3500);
  });

  it("XERO-RPT-003: net profit is found by summary label", () => {
    expect(reportSectionTotal(PNL, "net profit")).toBe(2750);
  });

  it("returns undefined for an unknown section", () => {
    expect(reportSectionTotal(PNL, "gross margin")).toBeUndefined();
  });

  it("XERO-RPT-009: reportDataRows lists section rows for top-N grouping", () => {
    const rows = reportDataRows(PNL, "expenses");
    expect(rows).toEqual([
      { section: "Less Operating Expenses", label: "Software", value: 2000 },
      { section: "Less Operating Expenses", label: "Rent", value: 1500 },
    ]);
  });
});
