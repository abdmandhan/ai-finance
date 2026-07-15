import type { InvoiceLine } from "@/schemas";
import type { XeroContact, XeroInvoiceDetail, XeroLineItem } from "@/tools";

export interface DueDateResolution {
  dueDate?: string;
  policy?: string;
  clamped: boolean;
}

export interface DuplicateCandidate {
  invoice: XeroInvoiceDetail;
  score: number;
  matched: string[];
}

export interface AmendmentPreviewInput {
  original: XeroInvoiceDetail;
  next: {
    reference?: string;
    date?: string;
    dueDate?: string;
    currencyCode?: string;
    lineItems?: XeroLineItem[];
  };
  reason?: string | null;
  fxWarning?: string | null;
  arBalance?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function endOfMonth(value: string): string {
  const date = parseDate(value);
  return formatDate(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)),
  );
}

function clampToToday(value: string, today: string): DueDateResolution {
  if (value < today) return { dueDate: today, clamped: true };
  return { dueDate: value, clamped: false };
}

function lineDescription(line: InvoiceLine | XeroLineItem): string {
  return String("Description" in line ? line.Description : line.description);
}

function lineQuantity(line: InvoiceLine | XeroLineItem): number {
  return Number("Quantity" in line ? line.Quantity : line.quantity);
}

function lineUnitAmount(line: InvoiceLine | XeroLineItem): number {
  return Number("UnitAmount" in line ? line.UnitAmount : line.unitAmount);
}

export function duePolicyFromContact(
  contact: XeroContact | null | undefined,
): string | null {
  const terms = contact?.PaymentTerms;
  const sales = terms?.Sales ?? terms?.Bills;
  const day = sales?.Day;
  const type = sales?.Type?.toUpperCase();
  if (typeof day !== "number" || !type) return null;
  if (type === "DAYSAFTERBILLDATE" || type === "DAYSAFTERINVOICEDATE") {
    return `net:${day}`;
  }
  if (type === "OFCURRENTMONTH") return `cycle:${day}`;
  if (type === "FOLLOWINGMONTH") return `eom+${day}`;
  return null;
}

export function resolveDueDate(params: {
  invoiceDate?: string | null;
  explicitDueDate?: string | null;
  duePolicy?: string | null;
  contact?: XeroContact | null;
  today: string;
}): DueDateResolution {
  const invoiceDate =
    params.invoiceDate && DATE_RE.test(params.invoiceDate)
      ? params.invoiceDate
      : params.today;
  const rawPolicy = params.duePolicy ?? duePolicyFromContact(params.contact);

  if (params.explicitDueDate && DATE_RE.test(params.explicitDueDate)) {
    return {
      ...clampToToday(params.explicitDueDate, params.today),
      policy: "explicit",
    };
  }
  if (!rawPolicy) return { clamped: false };

  const policy = rawPolicy.trim().toLowerCase();
  let dueDate: string | undefined;
  if (DATE_RE.test(policy)) {
    dueDate = policy;
  } else if (policy === "same_as_invoice") {
    dueDate = invoiceDate;
  } else if (/^net:?\d+$/.test(policy)) {
    dueDate = addDays(invoiceDate, Number(policy.replace(/^net:?/, "")));
  } else if (policy === "eom") {
    dueDate = endOfMonth(invoiceDate);
  } else if (/^eom\+\d+$/.test(policy)) {
    dueDate = addDays(endOfMonth(invoiceDate), Number(policy.slice(4)));
  } else if (/^cycle:\d+$/.test(policy)) {
    const day = Math.max(1, Math.min(31, Number(policy.slice(6))));
    const base = parseDate(invoiceDate);
    let due = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), day),
    );
    if (formatDate(due) < invoiceDate) {
      due = new Date(
        Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, day),
      );
    }
    dueDate = formatDate(due);
  }

  if (!dueDate) return { clamped: false, policy: rawPolicy };
  return { ...clampToToday(dueDate, params.today), policy: rawPolicy };
}

export function invoiceLineTotal(
  lines: Array<InvoiceLine | XeroLineItem> | null | undefined,
): number {
  return (lines ?? []).reduce(
    (sum, line) => sum + lineQuantity(line) * lineUnitAmount(line),
    0,
  );
}

export function invoiceLineSignature(
  lines: Array<InvoiceLine | XeroLineItem> | null | undefined,
): string {
  return (lines ?? [])
    .map((line) => {
      const description = lineDescription(line)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
      const quantity = lineQuantity(line).toFixed(4);
      const unitAmount = lineUnitAmount(line).toFixed(4);
      return `${description}:${quantity}:${unitAmount}`;
    })
    .sort()
    .join("|");
}

export function scoreDuplicateInvoice(
  candidate: XeroInvoiceDetail,
  target: {
    contactId?: string | null;
    total?: number;
    lineSignature?: string;
    reference?: string | null;
  },
): DuplicateCandidate {
  const matched: string[] = [];
  if (target.contactId && candidate.Contact?.ContactID === target.contactId) {
    matched.push("customer");
  }
  if (
    target.total !== undefined &&
    candidate.Total !== undefined &&
    Math.abs(candidate.Total - target.total) < 0.01
  ) {
    matched.push("amount");
  }
  if (
    target.lineSignature &&
    invoiceLineSignature(candidate.LineItems) === target.lineSignature
  ) {
    matched.push("line items");
  }
  const ref = (target.reference ?? "").trim().toLowerCase();
  const candidateRef = (candidate.Reference ?? candidate.InvoiceNumber ?? "")
    .trim()
    .toLowerCase();
  if (ref && candidateRef && ref === candidateRef) matched.push("reference");
  return { invoice: candidate, score: matched.length, matched };
}

export function invoiceDateWindowAround(
  date: string,
  days: number,
): { from: string; to: string } {
  return { from: addDays(date, -days), to: addDays(date, days) };
}

function formatMoney(value: number | undefined, currency?: string): string {
  const amount =
    value === undefined
      ? "unknown"
      : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency ? `${currency} ${amount}` : amount;
}

function lineLabel(line: XeroLineItem): string {
  return `${line.Description} x ${line.Quantity} @ ${line.UnitAmount}`;
}

export function buildAmendmentPreview(input: AmendmentPreviewInput): string {
  const changes: string[] = [];
  const original = input.original;
  const next = input.next;

  const field = (label: string, before: unknown, after: unknown) => {
    if (after !== undefined && after !== before) {
      changes.push(`${label}: ${before ?? "blank"} -> ${after}`);
    }
  };

  field("Reference", original.Reference, next.reference);
  field("Date", original.Date, next.date);
  field("Due date", original.DueDate, next.dueDate);
  field("Currency", original.CurrencyCode, next.currencyCode);

  if (
    next.lineItems &&
    invoiceLineSignature(next.lineItems) !==
      invoiceLineSignature(original.LineItems)
  ) {
    changes.push(
      `Lines: ${formatMoney(invoiceLineTotal(original.LineItems), original.CurrencyCode)} -> ${formatMoney(
        invoiceLineTotal(next.lineItems),
        next.currencyCode ?? original.CurrencyCode,
      )}`,
    );
    changes.push(`New lines: ${next.lineItems.map(lineLabel).join("; ")}`);
  }

  if (!changes.length) changes.push("No field changes were detected.");
  if (input.reason) changes.push(`Reason: ${input.reason}`);
  if (input.arBalance !== null && input.arBalance !== undefined) {
    changes.push(
      `Customer AR balance: ${formatMoney(input.arBalance, original.CurrencyCode)}`,
    );
  }
  if (input.fxWarning) changes.push(input.fxWarning);

  return changes.join("\n");
}
