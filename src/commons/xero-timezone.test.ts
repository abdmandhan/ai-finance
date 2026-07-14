import { describe, expect, it } from "vitest";
import { resolvePeriod } from "./periods";
import { isIanaTimezone, toIanaTimezone } from "./xero-timezone";

const NOW = new Date("2026-07-12T14:30:00Z");

describe("toIanaTimezone", () => {
  it("passes through valid IANA timezones", () => {
    expect(toIanaTimezone("Asia/Singapore")).toBe("Asia/Singapore");
    expect(toIanaTimezone("UTC")).toBe("UTC");
  });

  it("maps Xero SEASIASTANDARDTIME to Asia/Bangkok", () => {
    expect(toIanaTimezone("SEASIASTANDARDTIME")).toBe("Asia/Bangkok");
  });

  it("maps other common Xero enums", () => {
    expect(toIanaTimezone("SINGAPORESTANDARDTIME")).toBe("Asia/Singapore");
    expect(toIanaTimezone("EASTERNSTANDARDTIME")).toBe("America/New_York");
    expect(toIanaTimezone("GMTSTANDARDTIME")).toBe("Europe/London");
  });

  it("falls back to UTC for unknown values", () => {
    expect(toIanaTimezone("NOT_A_REAL_ZONE")).toBe("UTC");
    expect(toIanaTimezone("")).toBe("UTC");
  });

  it("mapped zones are accepted by Intl", () => {
    expect(isIanaTimezone(toIanaTimezone("SEASIASTANDARDTIME"))).toBe(true);
  });
});

describe("resolvePeriod with Xero timezone", () => {
  it("does not throw on SEASIASTANDARDTIME after normalization", () => {
    const tz = toIanaTimezone("SEASIASTANDARDTIME");
    const p = resolvePeriod("this_month", NOW, tz);
    // Bangkok is UTC+7; 14:30Z → 21:30 local on the 12th → July 2026.
    expect(p).toMatchObject({ from: "2026-07-01", to: "2026-07-31" });
  });
});
