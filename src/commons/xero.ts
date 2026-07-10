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
  const active = accounts.filter((a) => (a.Status ?? "ACTIVE") === "ACTIVE");

  // 1. Pick the account: config override → first active account of the right kind → any active.
  const overrideCode =
    kind === "REVENUE" ? cfg.revenueAccountCode : cfg.expenseAccountCode;
  const wanted =
    kind === "REVENUE"
      ? ["REVENUE", "SALES", "OTHERINCOME"]
      : ["EXPENSE", "OVERHEADS", "DIRECTCOSTS"];
  const account = overrideCode
    ? active.find((a) => a.Code === overrideCode)
    : (active.find((a) => wanted.includes((a.Type ?? "").toUpperCase())) ??
      active[0]);
  const accountCode = overrideCode || account?.Code;

  // 2. Pick the tax: config override → the chosen ACCOUNT's own default TaxType (guaranteed
  //    compatible with that account) → any 0%/exempt active rate as a last resort.
  let taxType = cfg.taxType || account?.TaxType || undefined;
  if (!taxType) {
    const activeRates = taxRates.filter(
      (r) => (r.Status ?? "ACTIVE") === "ACTIVE",
    );
    const zero = activeRates.find(
      (r) => (r.EffectiveRate ?? r.DisplayTaxRate ?? 0) === 0,
    );
    taxType = (zero ?? activeRates[0])?.TaxType;
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
