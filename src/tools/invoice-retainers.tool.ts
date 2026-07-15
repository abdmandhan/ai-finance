import type { ILogger } from "@/commons";
import type { InvoiceLine } from "@/schemas";
import { Pool } from "pg";

export interface RetainerKey {
  tenantId: string;
  contactId?: string | null;
  contactName: string;
  name?: string | null;
}

export interface InvoiceRetainer {
  tenantId: string;
  contactId?: string | null;
  contactName: string;
  name: string;
  amount: number;
  currencyCode: string;
  description?: string | null;
  lines?: InvoiceLine[] | null;
  frequency: string;
  billingDay?: number | null;
  duePolicy?: string | null;
  accountCode?: string | null;
  taxType?: string | null;
  referenceTemplate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status: "active" | "paused";
  notes?: string | null;
  updatedAt: string;
}

export interface UpsertInvoiceRetainerInput {
  tenantId: string;
  contactId?: string | null;
  contactName: string;
  name?: string | null;
  amount: number;
  currencyCode: string;
  description?: string | null;
  lines?: InvoiceLine[] | null;
  frequency?: string | null;
  billingDay?: number | null;
  duePolicy?: string | null;
  accountCode?: string | null;
  taxType?: string | null;
  referenceTemplate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: "active" | "paused";
  notes?: string | null;
}

export interface IInvoiceRetainersTool {
  setup(): Promise<void>;
  upsert(input: UpsertInvoiceRetainerInput): Promise<InvoiceRetainer>;
  delete(key: RetainerKey): Promise<boolean>;
  list(key: {
    tenantId: string;
    contactId?: string | null;
    contactName?: string | null;
  }): Promise<InvoiceRetainer[]>;
  findActive(key: RetainerKey): Promise<InvoiceRetainer[]>;
}

export const INVOICE_RETAINERS_DDL = `
CREATE TABLE IF NOT EXISTS invoice_retainers (
  tenant_id text NOT NULL,
  contact_key text NOT NULL,
  contact_id text,
  contact_name text NOT NULL,
  name text NOT NULL,
  amount numeric NOT NULL,
  currency_code text NOT NULL,
  description text,
  lines jsonb,
  frequency text NOT NULL DEFAULT 'monthly',
  billing_day integer,
  due_policy text,
  account_code text,
  tax_type text,
  reference_template text,
  start_date date,
  end_date date,
  status text NOT NULL DEFAULT 'active',
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, contact_key, name)
)`;

const norm = (value: string | null | undefined) =>
  (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

function contactKey(input: {
  contactId?: string | null;
  contactName: string;
}): string {
  return input.contactId
    ? `id:${input.contactId}`
    : `name:${norm(input.contactName)}`;
}

function retainerName(input: {
  name?: string | null;
  description?: string | null;
}): string {
  return norm(input.name) || norm(input.description) || "monthly retainer";
}

function rowToRetainer(row: Record<string, unknown>): InvoiceRetainer {
  return {
    tenantId: String(row.tenant_id),
    contactId: (row.contact_id as string | null) ?? null,
    contactName: String(row.contact_name),
    name: String(row.name),
    amount: Number(row.amount),
    currencyCode: String(row.currency_code),
    description: (row.description as string | null) ?? null,
    lines: (row.lines as InvoiceLine[] | null) ?? null,
    frequency: String(row.frequency),
    billingDay: (row.billing_day as number | null) ?? null,
    duePolicy: (row.due_policy as string | null) ?? null,
    accountCode: (row.account_code as string | null) ?? null,
    taxType: (row.tax_type as string | null) ?? null,
    referenceTemplate: (row.reference_template as string | null) ?? null,
    startDate: (row.start_date as string | null) ?? null,
    endDate: (row.end_date as string | null) ?? null,
    status: row.status === "paused" ? "paused" : "active",
    notes: (row.notes as string | null) ?? null,
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export class PostgresInvoiceRetainersTool implements IInvoiceRetainersTool {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async setup(): Promise<void> {
    await this.pool.query(INVOICE_RETAINERS_DDL);
  }

  async upsert(input: UpsertInvoiceRetainerInput): Promise<InvoiceRetainer> {
    const name = retainerName(input);
    const res = await this.pool.query(
      `INSERT INTO invoice_retainers (
        tenant_id, contact_key, contact_id, contact_name, name, amount, currency_code,
        description, lines, frequency, billing_day, due_policy, account_code, tax_type,
        reference_template, start_date, end_date, status, notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      ON CONFLICT (tenant_id, contact_key, name)
      DO UPDATE SET
        contact_id = EXCLUDED.contact_id,
        contact_name = EXCLUDED.contact_name,
        amount = EXCLUDED.amount,
        currency_code = EXCLUDED.currency_code,
        description = EXCLUDED.description,
        lines = EXCLUDED.lines,
        frequency = EXCLUDED.frequency,
        billing_day = EXCLUDED.billing_day,
        due_policy = EXCLUDED.due_policy,
        account_code = EXCLUDED.account_code,
        tax_type = EXCLUDED.tax_type,
        reference_template = EXCLUDED.reference_template,
        start_date = EXCLUDED.start_date,
        end_date = EXCLUDED.end_date,
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        updated_at = now()
      RETURNING *`,
      [
        input.tenantId,
        contactKey(input),
        input.contactId ?? null,
        input.contactName,
        name,
        input.amount,
        input.currencyCode,
        input.description ?? null,
        JSON.stringify(input.lines ?? null),
        input.frequency ?? "monthly",
        input.billingDay ?? null,
        input.duePolicy ?? null,
        input.accountCode ?? null,
        input.taxType ?? null,
        input.referenceTemplate ?? null,
        input.startDate ?? null,
        input.endDate ?? null,
        input.status ?? "active",
        input.notes ?? null,
      ],
    );
    return rowToRetainer(res.rows[0]);
  }

  async delete(key: RetainerKey): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM invoice_retainers
       WHERE tenant_id = $1 AND contact_key = $2 AND name = $3`,
      [key.tenantId, contactKey(key), retainerName(key)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async list(key: {
    tenantId: string;
    contactId?: string | null;
    contactName?: string | null;
  }): Promise<InvoiceRetainer[]> {
    const values: unknown[] = [key.tenantId];
    let where = "tenant_id = $1";
    if (key.contactId || key.contactName) {
      values.push(
        key.contactId ? `id:${key.contactId}` : `name:${norm(key.contactName)}`,
      );
      where += ` AND contact_key = $${values.length}`;
    }
    const res = await this.pool.query(
      `SELECT * FROM invoice_retainers WHERE ${where} ORDER BY contact_name, name`,
      values,
    );
    return res.rows.map(rowToRetainer);
  }

  async findActive(key: RetainerKey): Promise<InvoiceRetainer[]> {
    const rows = await this.list({
      tenantId: key.tenantId,
      contactId: key.contactId ?? undefined,
      contactName: key.contactName,
    });
    const fallbackRows = key.contactId
      ? await this.list({
          tenantId: key.tenantId,
          contactName: key.contactName,
        })
      : [];
    const name = norm(key.name);
    return [...rows, ...fallbackRows].filter(
      (r, index, all) =>
        r.status === "active" &&
        (!name || norm(r.name) === name) &&
        all.findIndex((other) => norm(other.name) === norm(r.name)) === index,
    );
  }
}

export class InMemoryInvoiceRetainersTool implements IInvoiceRetainersTool {
  private store = new Map<string, InvoiceRetainer>();

  async setup(): Promise<void> {}

  async upsert(input: UpsertInvoiceRetainerInput): Promise<InvoiceRetainer> {
    const name = retainerName(input);
    const key = `${input.tenantId}\0${contactKey(input)}\0${name}`;
    const existing = this.store.get(key);
    const retainer: InvoiceRetainer = {
      tenantId: input.tenantId,
      contactId: input.contactId ?? null,
      contactName: input.contactName,
      name,
      amount: input.amount,
      currencyCode: input.currencyCode,
      description: input.description ?? existing?.description ?? null,
      lines: input.lines ?? existing?.lines ?? null,
      frequency: input.frequency ?? existing?.frequency ?? "monthly",
      billingDay: input.billingDay ?? existing?.billingDay ?? null,
      duePolicy: input.duePolicy ?? existing?.duePolicy ?? null,
      accountCode: input.accountCode ?? existing?.accountCode ?? null,
      taxType: input.taxType ?? existing?.taxType ?? null,
      referenceTemplate:
        input.referenceTemplate ?? existing?.referenceTemplate ?? null,
      startDate: input.startDate ?? existing?.startDate ?? null,
      endDate: input.endDate ?? existing?.endDate ?? null,
      status: input.status ?? existing?.status ?? "active",
      notes: input.notes ?? existing?.notes ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(key, retainer);
    return retainer;
  }

  async delete(key: RetainerKey): Promise<boolean> {
    return this.store.delete(
      `${key.tenantId}\0${contactKey(key)}\0${retainerName(key)}`,
    );
  }

  async list(key: {
    tenantId: string;
    contactId?: string | null;
    contactName?: string | null;
  }): Promise<InvoiceRetainer[]> {
    const contact =
      key.contactId || key.contactName
        ? key.contactId
          ? `id:${key.contactId}`
          : `name:${norm(key.contactName)}`
        : null;
    return [...this.store.entries()]
      .filter(
        ([k]) =>
          k.startsWith(`${key.tenantId}\0`) &&
          (!contact || k.includes(`\0${contact}\0`)),
      )
      .map(([, value]) => value)
      .sort((a, b) =>
        `${a.contactName}:${a.name}`.localeCompare(
          `${b.contactName}:${b.name}`,
        ),
      );
  }

  async findActive(key: RetainerKey): Promise<InvoiceRetainer[]> {
    const rows = await this.list({
      tenantId: key.tenantId,
      contactId: key.contactId ?? undefined,
      contactName: key.contactName,
    });
    const fallbackRows = key.contactId
      ? await this.list({
          tenantId: key.tenantId,
          contactName: key.contactName,
        })
      : [];
    const name = norm(key.name);
    return [...rows, ...fallbackRows].filter(
      (r, index, all) =>
        r.status === "active" &&
        (!name || norm(r.name) === name) &&
        all.findIndex((other) => norm(other.name) === norm(r.name)) === index,
    );
  }
}

export async function setupInvoiceRetainersDb(
  databaseUrl: string,
  logger: ILogger,
): Promise<void> {
  if (!databaseUrl) {
    logger.warn(
      "No database.url configured — skipping invoice_retainers table setup",
    );
    return;
  }
  await new PostgresInvoiceRetainersTool(databaseUrl).setup();
}

export function createInvoiceRetainersTool(
  databaseUrl: string,
  logger: ILogger,
): IInvoiceRetainersTool {
  if (!databaseUrl) {
    logger.warn(
      "No database.url configured — using in-memory invoice retainers",
    );
    return new InMemoryInvoiceRetainersTool();
  }
  return new PostgresInvoiceRetainersTool(databaseUrl);
}
