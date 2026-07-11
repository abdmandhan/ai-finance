import { describe, expect, it } from "vitest";
import {
  applyLineDefaults,
  matchTaxRate,
  resolveOrgDefaults,
  taxRatePercentOf,
} from "./xero";
import type { XeroAccount, XeroTaxRate } from "@/tools";

const cfg = { taxType: "", expenseAccountCode: "", revenueAccountCode: "" };

describe("resolveOrgDefaults", () => {
  const accounts: XeroAccount[] = [
    {
      Code: "200",
      Name: "Sales",
      Type: "REVENUE",
      Status: "ACTIVE",
      TaxType: "OUTPUT2",
    },
    {
      Code: "310",
      Name: "Cost of Goods",
      Type: "DIRECTCOSTS",
      Status: "ACTIVE",
      TaxType: "INPUT2",
    },
  ];
  // A 0% rate that is NOT valid on every account — the old logic would pick this and clash.
  const taxRates: XeroTaxRate[] = [
    { TaxType: "GSTONIMPORTS", EffectiveRate: 0, Status: "ACTIVE" },
  ];

  it("uses the chosen account's own TaxType (not a globally-picked 0% rate)", () => {
    const rev = resolveOrgDefaults(accounts, taxRates, "REVENUE", cfg);
    expect(rev.accountCode).toBe("200");
    expect(rev.taxType).toBe("OUTPUT2"); // account 200's tax, not GSTONIMPORTS

    const exp = resolveOrgDefaults(accounts, taxRates, "EXPENSE", cfg);
    expect(exp.accountCode).toBe("310");
    expect(exp.taxType).toBe("INPUT2");
  });

  it("honours config overrides", () => {
    const out = resolveOrgDefaults(accounts, taxRates, "REVENUE", {
      taxType: "ZERORATED",
      revenueAccountCode: "310",
      expenseAccountCode: "",
    });
    expect(out.accountCode).toBe("310");
    expect(out.taxType).toBe("ZERORATED");
  });

  it("falls back to a 0% rate when the account has no TaxType", () => {
    const noTax: XeroAccount[] = [
      { Code: "200", Type: "REVENUE", Status: "ACTIVE" },
    ];
    const out = resolveOrgDefaults(noTax, taxRates, "REVENUE", cfg);
    expect(out.taxType).toBe("GSTONIMPORTS");
  });

  it("matchTaxRate finds a rate by percent, taxRatePercentOf reads it back", () => {
    const rates: XeroTaxRate[] = [
      { TaxType: "NONE", EffectiveRate: 0, Status: "ACTIVE" },
      { TaxType: "GST9", EffectiveRate: 9, Status: "ACTIVE" },
    ];
    expect(matchTaxRate(rates, 9)).toBe("GST9");
    expect(matchTaxRate(rates, 7)).toBeUndefined();
    expect(taxRatePercentOf(rates, "GST9")).toBe(9);
    expect(taxRatePercentOf(rates, "NONE")).toBe(0);
    expect(taxRatePercentOf(rates, undefined)).toBe(0);
  });

  it("applyLineDefaults fills only missing fields", () => {
    const lines = [
      { Description: "a", Quantity: 1, UnitAmount: 10 },
      {
        Description: "b",
        Quantity: 1,
        UnitAmount: 20,
        AccountCode: "999",
        TaxType: "KEEP",
      },
    ];
    applyLineDefaults(lines, { accountCode: "200", taxType: "OUTPUT2" });
    expect(lines[0].AccountCode).toBe("200");
    expect(lines[0].TaxType).toBe("OUTPUT2");
    expect(lines[1].AccountCode).toBe("999"); // untouched
    expect(lines[1].TaxType).toBe("KEEP");
  });
});
