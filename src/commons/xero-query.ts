/**
 * Pure helpers for querying Xero: typed-filter → `where` clause serialization,
 * account matching, and tolerant report-row parsing. No I/O here.
 */
import type {
  InvoiceQuery,
  PaymentQuery,
  XeroAccount,
  XeroReport,
  XeroReportRow,
} from "@/tools";

/** `DateTime(y, m, d)` literal from YYYY-MM-DD — Xero's where-clause date syntax. */
function xeroDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `DateTime(${y}, ${m}, ${d})`;
}

function quote(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

/** Serialize a typed InvoiceQuery into a Xero `where` clause (Statuses is a separate param). */
export function buildInvoiceWhere(q: InvoiceQuery): string {
  const parts: string[] = [];
  if (q.type) parts.push(`Type == ${quote(q.type)}`);
  if (q.contactId) parts.push(`Contact.ContactID == Guid(${quote(q.contactId)})`);
  if (q.invoiceNumber) parts.push(`InvoiceNumber == ${quote(q.invoiceNumber)}`);
  if (q.reference) parts.push(`Reference == ${quote(q.reference)}`);
  if (q.dueBefore) parts.push(`DueDate < ${xeroDate(q.dueBefore)}`);
  if (q.dueAfter) parts.push(`DueDate >= ${xeroDate(q.dueAfter)}`);
  if (q.dateFrom) parts.push(`Date >= ${xeroDate(q.dateFrom)}`);
  if (q.dateTo) parts.push(`Date <= ${xeroDate(q.dateTo)}`);
  if (q.unpaidOnly) parts.push(`AmountDue > 0`);
  if (q.amountDueMin !== undefined) parts.push(`AmountDue >= ${q.amountDueMin}`);
  return parts.join(" AND ");
}

/** Serialize a PaymentQuery; deleted payments are always excluded. */
export function buildPaymentWhere(q: PaymentQuery): string {
  const parts: string[] = [`Status == "AUTHORISED"`];
  if (q.dateFrom) parts.push(`Date >= ${xeroDate(q.dateFrom)}`);
  if (q.dateTo) parts.push(`Date <= ${xeroDate(q.dateTo)}`);
  if (q.reference) parts.push(`Reference == ${quote(q.reference)}`);
  return parts.join(" AND ");
}

/** Active bank accounts only. */
export function bankAccountsOf(accounts: XeroAccount[]): XeroAccount[] {
  return accounts.filter(
    (a) =>
      (a.Type ?? "").toUpperCase() === "BANK" &&
      (a.Status ?? "ACTIVE") === "ACTIVE",
  );
}

/**
 * Match ACTIVE accounts against a user hint — exact code first, then
 * case-insensitive name containment (either direction, so "BCA" matches
 * "BCA Checking" and "business bank" matches "Business Bank Account").
 * Archived accounts never match (XERO-ACC-003).
 */
export function matchAccountByHint(
  accounts: XeroAccount[],
  hint: string,
): XeroAccount[] {
  const active = accounts.filter((a) => (a.Status ?? "ACTIVE") === "ACTIVE");
  const h = hint.trim().toLowerCase();
  if (!h) return [];
  const byCode = active.filter((a) => (a.Code ?? "").toLowerCase() === h);
  if (byCode.length) return byCode;
  return active.filter((a) => {
    const name = (a.Name ?? "").toLowerCase();
    return name.includes(h) || h.includes(name);
  });
}

export interface FlatReportRow {
  section: string;
  rowType: string;
  cells: (string | number | undefined)[];
}

/** Depth-first flatten of Xero's nested report rows, tagging each with its section title. */
export function flattenReportRows(report: XeroReport): FlatReportRow[] {
  const out: FlatReportRow[] = [];
  const walk = (rows: XeroReportRow[], section: string) => {
    for (const row of rows) {
      const title = row.Title ?? section;
      if (row.Rows?.length) {
        walk(row.Rows, title);
        continue;
      }
      out.push({
        section,
        rowType: row.RowType ?? "",
        cells: (row.Cells ?? []).map((c) => c.Value),
      });
    }
  };
  walk(report.Rows ?? [], "");
  return out;
}

function toNumber(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/,/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

/**
 * Total of a report section (its SummaryRow's last numeric cell), matched by a
 * case-insensitive substring of either the section title or the summary label —
 * so "income" finds "Total Income" and "net profit" finds the Net Profit row.
 */
export function reportSectionTotal(
  report: XeroReport,
  title: string,
): number | undefined {
  const t = title.toLowerCase();
  const flat = flattenReportRows(report);
  for (const row of flat) {
    if (row.rowType !== "SummaryRow" && row.rowType !== "Row") continue;
    const label = String(row.cells[0] ?? "").toLowerCase();
    const sectionMatch =
      row.rowType === "SummaryRow" && row.section.toLowerCase().includes(t);
    if (!sectionMatch && !label.includes(t)) continue;
    const value = toNumber(row.cells[row.cells.length - 1]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Named data rows of a report (label + last numeric cell), for top-N/grouping answers. */
export function reportDataRows(
  report: XeroReport,
  sectionFilter?: string,
): { section: string; label: string; value: number }[] {
  const f = sectionFilter?.toLowerCase();
  return flattenReportRows(report)
    .filter((r) => r.rowType === "Row")
    .filter((r) => !f || r.section.toLowerCase().includes(f))
    .flatMap((r) => {
      const label = String(r.cells[0] ?? "");
      const value = toNumber(r.cells[r.cells.length - 1]);
      return label && value !== undefined
        ? [{ section: r.section, label, value }]
        : [];
    });
}
