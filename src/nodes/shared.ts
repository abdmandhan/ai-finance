import type { ILogger } from "@/commons";
import type { OrgDefaultsConfig, SchedulingPrefs } from "@/commons";
import type { ProgressEvent } from "@/schemas";
import type {
  FetchAttachment,
  ILlmService,
  ResolveAuth,
  ResolveXeroAuth,
} from "@/services";
import type {
  ICalendarTool,
  IContactsTool,
  IMapsTool,
  IPreferencesTool,
  IXeroTool,
  PreferenceKind,
} from "@/tools";

/** Working-hours + buffer prefs driving free-slot search. */
export interface SchedulingPrefsConfig {
  bufferMinutes: number;
  workingHoursStart: number;
  workingHoursEnd: number;
}

/** Dependencies injected into every node factory at graph build time. */
export interface ScheduleDeps {
  llmService: ILlmService;
  calendarTool: ICalendarTool;
  contactsTool: IContactsTool;
  mapsTool: IMapsTool;
  /** Resolve per-tenant Google auth (token endpoint). Faked in Studio/tests. */
  resolveAuth: ResolveAuth;
  /** IANA timezone used to anchor relative-time resolution when the message states none. */
  defaultTimezone: string;
  schedulingPrefs: SchedulingPrefsConfig;
  /** Per-user saved preferences (working hours, lunch, buffer, tz) — override global config. */
  preferencesTool: IPreferencesTool;
  logger: ILogger;
  /**
   * Fire-and-forget progress sink (chatId + chat.events payload). Defaults to a
   * no-op so the graph runs in Studio without a Kafka connection.
   */
  onProgress?: (chatId: string, event: ProgressEvent) => void;
}

/**
 * Payload handed to `interrupt()` — read by the runtime driver to build a `chat.outbound`
 * message. Scheduling only clarifies; Xero invoicing also gates on an approval (draft →
 * approve → authorise), carrying structured `approval` data → `output.approvalData`.
 */
export type InterruptPayload =
  | { kind: "clarification"; message: string }
  | { kind: "proposal"; message: string }
  | {
      kind: "approval";
      message: string;
      approval: {
        name: string;
        provider: string;
        items: { ref: string; label?: string }[];
      };
    };

/** Resume value threaded back into a paused graph via `Command({ resume })`. */
export interface ResumeInput {
  reply?: string;
  approved?: boolean;
}

/** Dependencies injected into invoice-graph nodes. */
export interface InvoiceDeps {
  llmService: ILlmService;
  xeroTool: IXeroTool;
  resolveXeroAuth: ResolveXeroAuth;
  orgDefaults: OrgDefaultsConfig;
  /** Download an attachment's bytes/data-url. Optional — image reading + attach skip when absent. */
  fetchAttachment?: FetchAttachment;
  logger: ILogger;
  onProgress?: (chatId: string, event: ProgressEvent) => void;
}

/**
 * Canonical node names, referenced by both nodes and the graph wiring.
 * Typed as `string` (no `as const`) so the StateGraph node-name generic stays
 * loose and conditional-edge path maps accept `Record<string, string>`.
 */
export const NODES: Record<string, string> = {
  parseIntent: "parse_intent",
  askClarification: "ask_clarification",
  resolveContact: "resolve_contact",
  searchCalendar: "search_calendar",
  lookupSchedule: "lookup_schedule",
  findSlot: "find_slot",
  awaitResolution: "await_resolution",
  createEvent: "create_event",
  saveContact: "save_contact",
  savePreference: "save_preference",
  listPreferences: "list_preferences",
  notify: "notify",
  finalize: "finalize",
};

/** Invoice-graph node names. */
export const INVOICE_NODES: Record<string, string> = {
  parseInvoice: "parse_invoice",
  askClarification: "ask_clarification",
  resolveContact: "resolve_xero_contact",
  createDraft: "create_draft_invoice",
  attach: "attach_invoice_file",
  approval: "invoice_approval",
  authorise: "authorise_invoice",
  finalize: "finalize_invoice",
};

export const DEFAULT_DURATION_MINUTES = 30;
export const MAX_CLARIFY_ATTEMPTS = 2;
/** Minutes of settling time after a flight arrival before the next onsite meeting. */
export const DEFAULT_POST_ARRIVAL_BUFFER_MINUTES = 30;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const numArray = (v: unknown): number[] | undefined =>
  Array.isArray(v) && v.every((n) => typeof n === "number")
    ? (v as number[])
    : undefined;
const timeWindow = (
  v: unknown,
): { startMinutes: number; endMinutes: number } | undefined => {
  const w = v as { startMinutes?: unknown; endMinutes?: unknown } | null;
  const start = num(w?.startMinutes);
  const end = num(w?.endMinutes);
  return start !== undefined && end !== undefined
    ? { startMinutes: start, endMinutes: end }
    : undefined;
};

/**
 * Effective scheduling prefs for a run: the user's saved preferences layered
 * over global config (user pref wins). `saved` is the raw jsonb snapshot from
 * the preferences tool; malformed values fall back to config silently.
 */
export function mergePrefs(
  base: SchedulingPrefsConfig & { timezone: string },
  saved: Partial<Record<PreferenceKind, unknown>> | null | undefined,
): SchedulingPrefs {
  const hours = saved?.working_hours as
    | { startHour?: unknown; endHour?: unknown }
    | undefined;
  const focusBlocks = Array.isArray(saved?.focus_blocks)
    ? (saved.focus_blocks as unknown[])
        .map((b) => {
          const w = timeWindow(b);
          if (!w) return undefined;
          const block = b as { days?: unknown; label?: unknown };
          return {
            ...w,
            days: numArray(block.days),
            label: typeof block.label === "string" ? block.label : undefined,
          };
        })
        .filter((b): b is NonNullable<typeof b> => b !== undefined)
    : undefined;
  return {
    bufferMinutes: num(saved?.buffer_minutes) ?? base.bufferMinutes,
    workingHoursStart: num(hours?.startHour) ?? base.workingHoursStart,
    workingHoursEnd: num(hours?.endHour) ?? base.workingHoursEnd,
    timezone:
      typeof saved?.timezone === "string" && saved.timezone
        ? saved.timezone
        : base.timezone,
    workingDays: numArray(saved?.working_days),
    noMeetingDays: numArray(saved?.no_meeting_days),
    lunch: timeWindow(saved?.lunch),
    focusBlocks,
  };
}

/** Saved post-arrival buffer, or the default. */
export function postArrivalBufferMinutes(
  saved: Partial<Record<PreferenceKind, unknown>> | null | undefined,
): number {
  return (
    num(saved?.post_arrival_buffer_minutes) ??
    DEFAULT_POST_ARRIVAL_BUFFER_MINUTES
  );
}

/** Fire-and-forget progress. Works for any deps exposing `onProgress`. */
export function emitProgress(
  deps: { onProgress?: (chatId: string, event: ProgressEvent) => void },
  chatId: string,
  stage: string,
  msg: string,
): void {
  deps.onProgress?.(chatId, {
    stage,
    msg,
    timestamp: new Date().toISOString(),
  });
}
