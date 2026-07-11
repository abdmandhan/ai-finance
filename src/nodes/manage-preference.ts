import type { ScheduleStateType } from "@/graphs/schedule.state";
import { preferenceExtractionSchema } from "@/schemas";
import { schedulePrompts } from "@/prompts";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PreferenceKind } from "@/tools";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  NODES,
  type ScheduleDeps,
} from "./shared";

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "HH:MM" → minutes since midnight; null when malformed. */
function hhmmToMinutes(v: string | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? "");
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function dayList(days: number[]): string {
  return days.map((d) => DAY_NAMES[d] ?? String(d)).join(", ");
}

/** Human-readable rendering of one saved preference (list + confirmations). */
function describePreference(kind: PreferenceKind, value: unknown): string {
  const v = value as Record<string, unknown>;
  switch (kind) {
    case "working_hours":
      return `Working hours: ${minutesToHhmm((v.startHour as number) * 60)}–${minutesToHhmm((v.endHour as number) * 60)}`;
    case "working_days":
      return `Working days: ${dayList(value as number[])}`;
    case "no_meeting_days":
      return `No-meeting days: ${dayList(value as number[])}`;
    case "buffer_minutes":
      return `Buffer between meetings: ${String(value)} min`;
    case "lunch":
      return `Lunch (kept free): ${minutesToHhmm(v.startMinutes as number)}–${minutesToHhmm(v.endMinutes as number)}`;
    case "focus_blocks": {
      const blocks = (value as Record<string, unknown>[])
        .map((b) => {
          const days = Array.isArray(b.days)
            ? ` on ${dayList(b.days as number[])}`
            : " daily";
          const label = b.label ? ` (${b.label as string})` : "";
          return `${minutesToHhmm(b.startMinutes as number)}–${minutesToHhmm(b.endMinutes as number)}${days}${label}`;
        })
        .join("; ");
      return `Focus blocks: ${blocks}`;
    }
    case "timezone":
      return `Timezone: ${String(value)}`;
    case "post_arrival_buffer_minutes":
      return `Buffer after a flight arrival: ${String(value)} min`;
  }
}

/**
 * Persist a standing scheduling preference ("no meetings Fridays", lunch, buffer,
 * timezone, focus blocks) or a correction ("you booked over my lunch"). Upsert —
 * restating a preference updates it in place. One-off exceptions never land here
 * (parse-intent keeps the booking intent and sets `oneOffOverride`).
 */
export function makeSavePreferenceNode(deps: ScheduleDeps) {
  return {
    name: NODES.savePreference,
    node: async (state: ScheduleStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "save_preference",
        "Saving your preference...",
      );

      try {
        const extraction = await deps.llmService.extract(
          preferenceExtractionSchema,
          [
            new SystemMessage(schedulePrompts.preferenceExtractPrompt()),
            new HumanMessage(state.userMessage),
          ],
          "preference",
        );

        const start = hhmmToMinutes(extraction.startTime);
        const end = hhmmToMinutes(extraction.endTime);
        const days = extraction.days?.map((d) => DAY_INDEX[d]) ?? null;

        // Normalize into (kind, value) pairs; working_hours with days sets both.
        const writes: { kind: PreferenceKind; value: unknown }[] = [];
        switch (extraction.kind) {
          case "working_hours":
            if (start !== null && end !== null) {
              writes.push({
                kind: "working_hours",
                value: { startHour: start / 60, endHour: end / 60 },
              });
            }
            if (days?.length) {
              writes.push({ kind: "working_days", value: days });
            }
            break;
          case "working_days":
            if (days?.length) writes.push({ kind: "working_days", value: days });
            break;
          case "no_meeting_days":
            if (days?.length)
              writes.push({ kind: "no_meeting_days", value: days });
            break;
          case "buffer_minutes":
            if (extraction.bufferMinutes)
              writes.push({
                kind: "buffer_minutes",
                value: extraction.bufferMinutes,
              });
            break;
          case "lunch": {
            const lunchStart = start ?? 12 * 60;
            const lunchEnd = end ?? 13 * 60;
            writes.push({
              kind: "lunch",
              value: { startMinutes: lunchStart, endMinutes: lunchEnd },
            });
            break;
          }
          case "focus_blocks":
            if (start !== null && end !== null) {
              writes.push({
                kind: "focus_blocks",
                value: [
                  {
                    startMinutes: start,
                    endMinutes: end,
                    ...(days?.length ? { days } : {}),
                    ...(extraction.label ? { label: extraction.label } : {}),
                  },
                ],
              });
            } else if (days?.length) {
              // "Wednesdays are meeting-free" style — a whole-day block is a no-meeting day.
              writes.push({ kind: "no_meeting_days", value: days });
            }
            break;
          case "timezone":
            if (extraction.timezone)
              writes.push({ kind: "timezone", value: extraction.timezone });
            break;
          case "post_arrival_buffer_minutes":
            if (extraction.bufferMinutes)
              writes.push({
                kind: "post_arrival_buffer_minutes",
                value: extraction.bufferMinutes,
              });
            break;
          default:
            break;
        }

        if (writes.length === 0) {
          if (state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
            return {
              clarificationQuestion:
                extraction.clarificationQuestion ??
                "Which scheduling preference should I save, exactly?",
              _nextNode: NODES.askClarification,
            };
          }
          return {
            result: {
              status: "failed" as const,
              summary: "Could not determine the preference to save.",
            },
            _nextNode: NODES.finalize,
          };
        }

        const key = { tenantId: state.tenantId, userId: state.userId };
        for (const w of writes) {
          await deps.preferencesTool.set(key, w.kind, w.value);
        }
        deps.logger.info(
          { kinds: writes.map((w) => w.kind) },
          "save-preference stored",
        );

        const described = writes
          .map((w) => describePreference(w.kind, w.value))
          .join(". ");
        return {
          result: {
            status: "answered" as const,
            summary: `Got it — saved. ${described}.`,
          },
          _nextNode: NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "save-preference failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not save the preference. Please try again later.",
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}

/** Read back everything saved for this principal ("what preferences do you have for me?"). */
export function makeListPreferencesNode(deps: ScheduleDeps) {
  return {
    name: NODES.listPreferences,
    node: async (state: ScheduleStateType) => {
      emitProgress(
        deps,
        state.threadId,
        "list_preferences",
        "Reading your preferences...",
      );

      try {
        const entries = await deps.preferencesTool.list({
          tenantId: state.tenantId,
          userId: state.userId,
        });
        const summary = entries.length
          ? `Your saved scheduling preferences:\n${entries
              .map((e) => `- ${describePreference(e.kind, e.value)}`)
              .join("\n")}`
          : "You have no saved scheduling preferences yet.";
        return {
          result: { status: "answered" as const, summary },
          _nextNode: NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "list-preferences failed");
        return {
          result: {
            status: "failed" as const,
            summary:
              "Could not read your preferences. Please try again later.",
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
