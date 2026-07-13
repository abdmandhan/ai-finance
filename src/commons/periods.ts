/**
 * Pure, timezone-aware reporting-period math. All returned dates are YYYY-MM-DD
 * in the organisation's timezone — Xero report params and invoice queries are
 * date-only, so no times are involved.
 */

export type PeriodToken =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "this_year"
  | "last_6_months"
  | "next_week"
  | "custom"
  | "none";

export interface ResolvedPeriod {
  from: string;
  to: string;
  label: string;
  /** True when the token was missing/none and we defaulted — the answer must say so. */
  defaulted?: boolean;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Calendar date parts of `now` as seen in `timezone`. */
export function localDateParts(
  now: Date,
  timezone: string,
): { y: number; m: number; d: number } {
  // en-CA formats as YYYY-MM-DD.
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/** Format calendar parts as YYYY-MM-DD, normalizing overflow (month 0 → prior Dec, etc). */
function ymd(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthLabel(y: number, m: number): string {
  // Normalize overflowed month via Date.
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

/** ISO day-of-week (1 = Monday … 7 = Sunday) for a calendar date. */
function isoWeekday(y: number, m: number, d: number): number {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return wd === 0 ? 7 : wd;
}

export function resolvePeriod(
  token: PeriodToken,
  now: Date,
  timezone: string,
  custom?: { from?: string | null; to?: string | null },
): ResolvedPeriod {
  const { y, m, d } = localDateParts(now, timezone);

  switch (token) {
    case "none":
      return { ...monthPeriod(y, m), defaulted: true };
    case "this_month":
      return monthPeriod(y, m);
    case "last_month":
      return monthPeriod(y, m - 1);
    case "this_quarter": {
      const qStartMonth = m - ((m - 1) % 3);
      const from = ymd(y, qStartMonth, 1);
      const to = ymd(y, qStartMonth + 2, lastDayOfMonth(y, qStartMonth + 2));
      const q = Math.floor((m - 1) / 3) + 1;
      return { from, to, label: `Q${q} ${y}` };
    }
    case "this_year":
      return { from: ymd(y, 1, 1), to: ymd(y, 12, 31), label: `${y}` };
    case "last_6_months": {
      const from = ymd(y, m - 5, 1);
      const to = ymd(y, m, d);
      return {
        from,
        to,
        label: `last 6 months (${monthLabel(y, m - 5)} – ${monthLabel(y, m)})`,
      };
    }
    case "next_week": {
      // Next ISO calendar week: next Monday through the Sunday after it.
      const daysToNextMonday = 8 - isoWeekday(y, m, d);
      const from = ymd(y, m, d + daysToNextMonday);
      const to = ymd(y, m, d + daysToNextMonday + 6);
      return { from, to, label: `next week (${from} – ${to})` };
    }
    case "custom": {
      if (!custom?.from || !custom?.to) {
        // Fall back rather than invent: default to this month, flagged.
        return { ...monthPeriod(y, m), defaulted: true };
      }
      return {
        from: custom.from,
        to: custom.to,
        label: `${custom.from} – ${custom.to}`,
      };
    }
  }
}

function monthPeriod(y: number, m: number): ResolvedPeriod {
  const from = ymd(y, m, 1);
  const to = ymd(y, m, lastDayOfMonth(y, m));
  return { from, to, label: monthLabel(y, m) };
}

/**
 * The preceding equivalent period, for comparisons. Whole-calendar-month windows
 * shift by months; anything else shifts back by its own day length.
 */
export function previousEquivalentPeriod(period: {
  from: string;
  to: string;
}): ResolvedPeriod {
  const [fy, fm, fd] = period.from.split("-").map(Number);
  const [ty, tm, td] = period.to.split("-").map(Number);

  const wholeMonths =
    fd === 1 && td === lastDayOfMonth(ty, tm);
  if (wholeMonths) {
    const monthSpan = (ty - fy) * 12 + (tm - fm) + 1;
    const from = ymd(fy, fm - monthSpan, 1);
    const prevEndMonthY = fy;
    const prevEndMonth = fm - 1;
    const to = ymd(prevEndMonthY, prevEndMonth, lastDayOfMonth(fy, fm - 1));
    const label =
      monthSpan === 1
        ? monthLabel(fy, fm - 1)
        : `${monthLabel(fy, fm - monthSpan)} – ${monthLabel(prevEndMonthY, prevEndMonth)}`;
    return { from, to, label };
  }

  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  const days = Math.round((toMs - fromMs) / 86_400_000) + 1;
  const from = ymd(fy, fm, fd - days);
  const to = ymd(fy, fm, fd - 1);
  return { from, to, label: `${from} – ${to}` };
}
