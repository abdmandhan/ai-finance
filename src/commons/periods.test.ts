import { describe, expect, it } from "vitest";
import {
  localDateParts,
  previousEquivalentPeriod,
  resolvePeriod,
} from "./periods";

// 2026-07-12 14:30 UTC — a Sunday. In Asia/Singapore (UTC+8) it is 22:30 the same day;
// in Pacific/Auckland (UTC+12) it is already Monday 2026-07-13.
const NOW = new Date("2026-07-12T14:30:00Z");
const TZ = "Asia/Singapore";

describe("localDateParts", () => {
  it("returns the calendar date as seen in the timezone", () => {
    expect(localDateParts(NOW, TZ)).toEqual({ y: 2026, m: 7, d: 12 });
    expect(localDateParts(NOW, "Pacific/Auckland")).toEqual({
      y: 2026,
      m: 7,
      d: 13,
    });
  });
});

describe("resolvePeriod", () => {
  it("XERO-RPT-001: this_month covers the full current calendar month", () => {
    const p = resolvePeriod("this_month", NOW, TZ);
    expect(p).toMatchObject({ from: "2026-07-01", to: "2026-07-31" });
    expect(p.label).toBe("July 2026");
    expect(p.defaulted).toBeUndefined();
  });

  it("XERO-RPT-002: last_month covers the entire previous calendar month", () => {
    const p = resolvePeriod("last_month", NOW, TZ);
    expect(p).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
    expect(p.label).toBe("June 2026");
  });

  it("last_month rolls across a year boundary", () => {
    const jan = new Date("2026-01-15T10:00:00Z");
    const p = resolvePeriod("last_month", jan, TZ);
    expect(p).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(p.label).toBe("December 2025");
  });

  it("this_quarter resolves the containing calendar quarter", () => {
    const p = resolvePeriod("this_quarter", NOW, TZ);
    expect(p).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(p.label).toBe("Q3 2026");
  });

  it("this_year is Jan 1 to Dec 31", () => {
    expect(resolvePeriod("this_year", NOW, TZ)).toMatchObject({
      from: "2026-01-01",
      to: "2026-12-31",
    });
  });

  it("last_6_months starts at the first of the month five months back", () => {
    const p = resolvePeriod("last_6_months", NOW, TZ);
    expect(p).toMatchObject({ from: "2026-02-01", to: "2026-07-12" });
  });

  it("XERO-EXP-010: next_week is next Monday through Sunday", () => {
    // NOW is Sunday 2026-07-12 in Singapore → next week is Mon 13 – Sun 19.
    const p = resolvePeriod("next_week", NOW, TZ);
    expect(p).toMatchObject({ from: "2026-07-13", to: "2026-07-19" });
  });

  it("XERO-AI-011: none defaults to this month and is flagged as defaulted", () => {
    const p = resolvePeriod("none", NOW, TZ);
    expect(p).toMatchObject({
      from: "2026-07-01",
      to: "2026-07-31",
      defaulted: true,
    });
  });

  it("XERO-RPT-014: custom uses the given inclusive bounds", () => {
    const p = resolvePeriod("custom", NOW, TZ, {
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(p).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("custom without bounds falls back to this month, flagged — never invents dates", () => {
    const p = resolvePeriod("custom", NOW, TZ, { from: null, to: null });
    expect(p).toMatchObject({ from: "2026-07-01", defaulted: true });
  });
});

describe("previousEquivalentPeriod", () => {
  it("XERO-EXP-006: a whole month compares against the whole previous month", () => {
    const p = previousEquivalentPeriod({ from: "2026-07-01", to: "2026-07-31" });
    expect(p).toMatchObject({ from: "2026-06-01", to: "2026-06-30" });
    expect(p.label).toBe("June 2026");
  });

  it("a whole quarter compares against the previous quarter", () => {
    const p = previousEquivalentPeriod({ from: "2026-07-01", to: "2026-09-30" });
    expect(p).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
  });

  it("January's previous month is December of the prior year", () => {
    const p = previousEquivalentPeriod({ from: "2026-01-01", to: "2026-01-31" });
    expect(p).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("an arbitrary window shifts back by its own length", () => {
    const p = previousEquivalentPeriod({ from: "2026-07-08", to: "2026-07-14" });
    expect(p).toMatchObject({ from: "2026-07-01", to: "2026-07-07" });
  });
});
