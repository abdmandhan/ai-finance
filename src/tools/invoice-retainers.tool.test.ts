import { describe, expect, it } from "vitest";
import {
  INVOICE_RETAINERS_DDL,
  InMemoryInvoiceRetainersTool,
} from "./invoice-retainers.tool";

describe("InMemoryInvoiceRetainersTool", () => {
  it("creates, updates, lists, and deletes a retainer", async () => {
    const tool = new InMemoryInvoiceRetainersTool();
    await tool.upsert({
      tenantId: "tenant-1",
      contactName: "Acme",
      name: "monthly support",
      amount: 500,
      currencyCode: "USD",
      description: "Monthly support",
    });
    await tool.upsert({
      tenantId: "tenant-1",
      contactName: "Acme",
      name: "monthly support",
      amount: 750,
      currencyCode: "USD",
    });

    const rows = await tool.list({ tenantId: "tenant-1", contactName: "Acme" });
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(750);

    expect(
      await tool.delete({
        tenantId: "tenant-1",
        contactName: "Acme",
        name: "monthly support",
      }),
    ).toBe(true);
    expect(await tool.list({ tenantId: "tenant-1" })).toEqual([]);
  });

  it("isolates tenants and can find a name-keyed retainer after contact id resolution", async () => {
    const tool = new InMemoryInvoiceRetainersTool();
    await tool.upsert({
      tenantId: "tenant-1",
      contactName: "Acme",
      name: "monthly support",
      amount: 500,
      currencyCode: "USD",
    });
    await tool.upsert({
      tenantId: "tenant-2",
      contactName: "Acme",
      name: "monthly support",
      amount: 999,
      currencyCode: "USD",
    });

    const match = await tool.findActive({
      tenantId: "tenant-1",
      contactId: "c-acme",
      contactName: "Acme",
      name: "monthly support",
    });

    expect(match).toHaveLength(1);
    expect(match[0].amount).toBe(500);
  });
});

describe("invoice_retainers DDL", () => {
  it("is idempotent and keys retainers by tenant/contact/name", () => {
    expect(INVOICE_RETAINERS_DDL).toContain(
      "CREATE TABLE IF NOT EXISTS invoice_retainers",
    );
    expect(INVOICE_RETAINERS_DDL).toContain(
      "PRIMARY KEY (tenant_id, contact_key, name)",
    );
  });
});
