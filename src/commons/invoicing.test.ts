import { describe, expect, it } from "vitest";
import { resolveDueDate } from "./invoicing";

describe("resolveDueDate", () => {
  const today = "2026-07-15";
  const invoiceDate = "2026-07-10";

  it.each([
    ["same_as_invoice", "2026-07-15"],
    ["net7", "2026-07-17"],
    ["net14", "2026-07-24"],
    ["net30", "2026-08-09"],
    ["net45", "2026-08-24"],
    ["net60", "2026-09-08"],
    ["net90", "2026-10-08"],
    ["eom", "2026-07-31"],
    ["eom+7", "2026-08-07"],
    ["cycle:15", "2026-07-15"],
    ["2026-08-20", "2026-08-20"],
  ])("%s resolves to %s", (duePolicy, dueDate) => {
    expect(resolveDueDate({ invoiceDate, duePolicy, today }).dueDate).toBe(
      dueDate,
    );
  });

  it("never returns a computed due date before today", () => {
    expect(
      resolveDueDate({
        invoiceDate: "2026-07-01",
        duePolicy: "net7",
        today,
      }),
    ).toMatchObject({ dueDate: today, clamped: true });
  });

  it("uses customer payment terms when no explicit policy is provided", () => {
    expect(
      resolveDueDate({
        invoiceDate,
        today,
        contact: {
          ContactID: "c1",
          Name: "Acme",
          PaymentTerms: { Sales: { Day: 30, Type: "DAYSAFTERBILLDATE" } },
        },
      }).dueDate,
    ).toBe("2026-08-09");
  });
});
