/**
 * Google Drive contacts store — ported from Agent's
 * `extensions/scheduling/src/contacts-client.ts`. Single CSV per tenant at
 * `/tigeri/agent-scheduling/contacts.csv` (header name,email,company,timezone,phone,notes).
 * Reuses the CalendarAuth accessToken (needs `drive.file` scope). Microsoft = graceful skip.
 */
import type { ILogger } from '@/commons';
import type { CalendarAuth } from '@/services/google-auth';

export interface Contact {
  name: string;
  email: string;
  company?: string;
  timezone?: string;
  phone?: string;
  notes?: string;
}

export type SaveContactResult =
  | { action: 'created' | 'updated' }
  | { action: 'needs_disambiguation'; matches: Contact[] };

export interface IContactsTool {
  lookup(auth: CalendarAuth, query: string): Promise<Contact[]>;
  save(auth: CalendarAuth, contact: Contact): Promise<SaveContactResult>;
}

const CSV_HEADER = 'name,email,company,timezone,phone,notes';
const FOLDER_PATH = ['tigeri', 'agent-scheduling'];
const FILE_NAME = 'contacts.csv';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

// ── CSV helpers ──────────────────────────────────────────────────────

function escapeCsv(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function serializeCsv(contacts: Contact[]): string {
  const rows = contacts.map((c) =>
    [c.name, c.email, c.company ?? '', c.timezone ?? '', c.phone ?? '', c.notes ?? '']
      .map(escapeCsv)
      .join(','),
  );
  return [CSV_HEADER, ...rows].join('\n');
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text: string): Contact[] {
  const rawLines = text.split(/\r?\n/);
  const rows: string[][] = [];
  let currentLine = '';
  let inQuote = false;
  for (const line of rawLines) {
    currentLine = currentLine ? currentLine + '\n' + line : line;
    let quotes = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        if (line[i + 1] === '"') i++;
        else quotes++;
      }
    }
    if (quotes % 2 !== 0) inQuote = !inQuote;
    if (!inQuote) {
      if (currentLine.trim()) rows.push(parseCsvRow(currentLine));
      currentLine = '';
    }
  }
  if (rows.length < 2) return [];
  return rows.slice(1).map((row) => {
    const [name = '', email = '', company = '', timezone = '', phone = '', notes = ''] = row;
    const c: Contact = { name, email };
    if (company) c.company = company;
    if (timezone) c.timezone = timezone;
    if (phone) c.phone = phone;
    if (notes) c.notes = notes;
    return c;
  });
}

function mergeContact(existing: Contact, update: Contact): Contact {
  const result = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

// ── Drive API helpers ────────────────────────────────────────────────

async function driveGet(
  auth: CalendarAuth,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(path.startsWith('http') ? path : `${DRIVE_FILES}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findItem(
  auth: CalendarAuth,
  name: string,
  parentId: string,
  mimeType?: string,
): Promise<string | null> {
  let q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
  if (mimeType) q += ` and mimeType='${mimeType}'`;
  const data = (await driveGet(auth, '', { q, fields: 'files(id)' })) as { files?: { id: string }[] };
  return data.files?.[0]?.id ?? null;
}

async function createFolder(auth: CalendarAuth, name: string, parentId: string): Promise<string> {
  const res = await fetch(DRIVE_FILES, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`Drive createFolder ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function downloadCsv(auth: CalendarAuth, fileId: string): Promise<Contact[]> {
  const res = await fetch(`${DRIVE_FILES}/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw new Error(`Drive download ${res.status}: ${await res.text()}`);
  return parseCsv(await res.text());
}

async function uploadCsv(auth: CalendarAuth, fileId: string, contacts: Contact[]): Promise<void> {
  const res = await fetch(`${DRIVE_UPLOAD}/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${auth.accessToken}`, 'content-type': 'text/csv' },
    body: serializeCsv(contacts),
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text()}`);
}

/** Real Google Drive-backed contacts store. */
export class DriveContactsTool implements IContactsTool {
  // Per-tenant caches (keyed by auth.emailAddress, as in the Agent plugin).
  private readonly cache = new Map<string, { fileId: string; contacts: Contact[] }>();
  private readonly fileIdCache = new Map<string, Promise<string>>();

  constructor(private readonly logger: ILogger) {}

  private async resolveFileId(auth: CalendarAuth, tenantId: string): Promise<string> {
    let promise = this.fileIdCache.get(tenantId);
    if (!promise) {
      promise = (async () => {
        const cached = this.cache.get(tenantId);
        if (cached) return cached.fileId;

        let parentId = 'root';
        for (const folder of FOLDER_PATH) {
          const existing = await findItem(auth, folder, parentId, 'application/vnd.google-apps.folder');
          parentId = existing ?? (await createFolder(auth, folder, parentId));
        }

        const existingFile = await findItem(auth, FILE_NAME, parentId);
        if (existingFile) return existingFile;

        // Create the CSV with just a header (multipart upload).
        const boundary = 'csvboundary';
        const body =
          `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
          JSON.stringify({ name: FILE_NAME, parents: [parentId] }) +
          `\r\n--${boundary}\r\nContent-Type: text/csv\r\n\r\n${CSV_HEADER}\n\r\n--${boundary}--`;
        const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            'content-type': `multipart/related; boundary=${boundary}`,
          },
          body,
        });
        if (!res.ok) throw new Error(`Drive createFile ${res.status}: ${await res.text()}`);
        return ((await res.json()) as { id: string }).id;
      })();
      promise.catch(() => this.fileIdCache.delete(tenantId));
      this.fileIdCache.set(tenantId, promise);
    }
    return promise;
  }

  async lookup(auth: CalendarAuth, query: string): Promise<Contact[]> {
    if (auth.provider !== 'google') return [];
    const tenantId = auth.emailAddress;
    const fileId = await this.resolveFileId(auth, tenantId);
    let contacts = this.cache.get(tenantId)?.contacts;
    if (!contacts) {
      contacts = await downloadCsv(auth, fileId);
      this.cache.set(tenantId, { fileId, contacts });
    }
    const q = query.toLowerCase();
    return contacts.filter((c) => c.name.toLowerCase().includes(q));
  }

  async save(auth: CalendarAuth, contact: Contact): Promise<SaveContactResult> {
    if (auth.provider !== 'google') return { action: 'created' };
    const tenantId = auth.emailAddress;
    const fileId = await this.resolveFileId(auth, tenantId);
    let contacts = this.cache.get(tenantId)?.contacts ?? (await downloadCsv(auth, fileId));

    // 1. Email match → update row.
    const emailIdx = contacts.findIndex((c) => c.email.toLowerCase() === contact.email.toLowerCase());
    if (emailIdx >= 0) {
      contacts[emailIdx] = mergeContact(contacts[emailIdx], contact);
      await uploadCsv(auth, fileId, contacts);
      this.cache.set(tenantId, { fileId, contacts });
      return { action: 'updated' };
    }

    // 2. Name match → update if unambiguous.
    const nameMatches = contacts.filter((c) => c.name.toLowerCase() === contact.name.toLowerCase());
    if (nameMatches.length > 1) return { action: 'needs_disambiguation', matches: nameMatches };
    if (nameMatches.length === 1) {
      const nameIdx = contacts.findIndex((c) => c.name.toLowerCase() === contact.name.toLowerCase());
      contacts[nameIdx] = mergeContact(contacts[nameIdx], contact);
      await uploadCsv(auth, fileId, contacts);
      this.cache.set(tenantId, { fileId, contacts });
      return { action: 'updated' };
    }

    // 3. No match → append.
    contacts = [...contacts, contact];
    await uploadCsv(auth, fileId, contacts);
    this.cache.set(tenantId, { fileId, contacts });
    this.logger.info({ name: contact.name }, 'contacts.save created new contact');
    return { action: 'created' };
  }
}

/** In-memory contacts store for Studio / tests (no Google creds). Seeded once, mutable. */
export class StubContactsTool implements IContactsTool {
  private readonly contacts: Contact[];
  constructor(seed: Contact[] = []) {
    this.contacts = [...seed];
  }

  async lookup(_auth: CalendarAuth, query: string): Promise<Contact[]> {
    const q = query.toLowerCase();
    return this.contacts.filter((c) => c.name.toLowerCase().includes(q));
  }

  async save(_auth: CalendarAuth, contact: Contact): Promise<SaveContactResult> {
    const idx = this.contacts.findIndex((c) => c.email.toLowerCase() === contact.email.toLowerCase());
    if (idx >= 0) {
      this.contacts[idx] = mergeContact(this.contacts[idx], contact);
      return { action: 'updated' };
    }
    this.contacts.push(contact);
    return { action: 'created' };
  }
}

export function createContactsTool(logger: ILogger): IContactsTool {
  return new DriveContactsTool(logger);
}
