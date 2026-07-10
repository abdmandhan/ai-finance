import type { ILogger } from "@/commons";
import type { OrgDefaultsConfig } from "@/commons";
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
  IXeroTool,
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
  createEvent: "create_event",
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
