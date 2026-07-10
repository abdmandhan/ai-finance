import type { XeroAccount, XeroLineItem, XeroTaxRate } from "@/tools";

/**
 * Pure Xero line-item helpers — ported from Agent's `extensions/xero/src/helpers.ts`
 * (`resolveOrgDefaults` / `applyLineDefaults`). Auto-fills AccountCode/TaxType so a DRAFT is
 * authorise-ready (Xero requires them to move DRAFT → AUTHORISED).
 */

export interface OrgDefaultsConfig {
  taxType: string;
  expenseAccountCode: string;
  revenueAccountCode: string;
}

export type AccountKind = "EXPENSE" | "REVENUE";

/** Config override first; else a 0%/exempt ACTIVE tax + first ACTIVE account of the kind. */
export function resolveOrgDefaults(
  accounts: XeroAccount[],
  taxRates: XeroTaxRate[],
  kind: AccountKind,
  cfg: OrgDefaultsConfig,
): { accountCode?: string; taxType?: string } {
  let taxType = cfg.taxType || undefined;
  if (!taxType) {
    const active = taxRates.filter((r) => (r.Status ?? "ACTIVE") === "ACTIVE");
    const zero = active.find(
      (r) => (r.EffectiveRate ?? r.DisplayTaxRate ?? 0) === 0,
    );
    taxType = (zero ?? active[0])?.TaxType;
  }

  let accountCode =
    (kind === "REVENUE" ? cfg.revenueAccountCode : cfg.expenseAccountCode) ||
    undefined;
  if (!accountCode) {
    const wanted =
      kind === "REVENUE"
        ? ["REVENUE", "SALES", "OTHERINCOME"]
        : ["EXPENSE", "OVERHEADS", "DIRECTCOSTS"];
    const active = accounts.filter((a) => (a.Status ?? "ACTIVE") === "ACTIVE");
    const match = active.find((a) =>
      wanted.includes((a.Type ?? "").toUpperCase()),
    );
    accountCode = (match ?? active[0])?.Code;
  }

  return { accountCode, taxType };
}

/** Fill any line missing AccountCode/TaxType with the resolved org defaults (in place). */
export function applyLineDefaults(
  lines: XeroLineItem[],
  defaults: { accountCode?: string; taxType?: string },
): void {
  for (const l of lines) {
    if (!l.AccountCode && defaults.accountCode)
      l.AccountCode = defaults.accountCode;
    if (!l.TaxType && defaults.taxType) l.TaxType = defaults.taxType;
  }
}
