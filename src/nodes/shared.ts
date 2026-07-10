import type { ILogger } from '@/commons';
import type { ProgressEvent } from '@/schemas';
import type { ILlmService } from '@/services';
import type { ICalendarTool } from '@/tools';

/** Dependencies injected into every node factory at graph build time. */
export interface ScheduleDeps {
  llmService: ILlmService;
  calendarTool: ICalendarTool;
  logger: ILogger;
  /**
   * Fire-and-forget progress sink (chatId + chat.events payload). Defaults to a
   * no-op so the graph runs in Studio without a Kafka connection.
   */
  onProgress?: (chatId: string, event: ProgressEvent) => void;
}

/**
 * Payload handed to `interrupt()` — read by the runtime driver to build a
 * `chat.outbound` clarification or approval message.
 */
export type InterruptPayload =
  | { kind: 'clarification'; message: string }
  | {
      kind: 'approval';
      message: string;
      approval: {
        name: string;
        provider?: string;
        items: { ref: string; label?: string }[];
        args?: unknown;
      };
    };

/** Resume value threaded back into a paused graph via `Command({ resume })`. */
export interface ResumeInput {
  reply?: string;
  approved?: boolean;
}

/**
 * Canonical node names, referenced by both nodes and the graph wiring.
 * Typed as `string` (no `as const`) so the StateGraph node-name generic stays
 * loose and conditional-edge path maps accept `Record<string, string>`.
 */
export const NODES: Record<string, string> = {
  parseIntent: 'parse_intent',
  askClarification: 'ask_clarification',
  searchCalendar: 'search_calendar',
  findSlot: 'find_slot',
  approval: 'approval',
  createEvent: 'create_event',
  notify: 'notify',
  finalize: 'finalize',
};

export const DEFAULT_DURATION_MINUTES = 30;
export const MAX_CLARIFY_ATTEMPTS = 2;

export function emitProgress(deps: ScheduleDeps, chatId: string, stage: string, msg: string): void {
  deps.onProgress?.(chatId, { stage, msg, timestamp: new Date().toISOString() });
}
