import type { ScheduleStateType } from "@/graphs/schedule.state";
import { schedulePrompts } from "@/prompts";
import { scheduleIntentSchema } from "@/schemas";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  DEFAULT_DURATION_MINUTES,
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  NODES,
  type ScheduleDeps,
} from "./shared";

/**
 * Extract scheduling entities from the user message. The LLM only extracts and
 * flags missing info; this node decides routing (clarify vs. search vs. fail).
 */
export function makeParseIntentNode(deps: ScheduleDeps) {
  return {
    name: NODES.parseIntent,
    node: async (
      state: ScheduleStateType,
    ): Promise<Partial<ScheduleStateType>> => {
      emitProgress(
        deps,
        state.threadId,
        "parse_intent",
        "Understanding your request...",
      );

      // Saved preferences snapshot — fetched once per run, reused downstream.
      let userPrefs = state.userPrefs;
      if (userPrefs === undefined || userPrefs === null) {
        try {
          userPrefs = await deps.preferencesTool.getAll({
            tenantId: state.tenantId,
            userId: state.userId,
          });
        } catch (err) {
          deps.logger.error({ err }, "preferences fetch failed — using config");
          userPrefs = {};
        }
      }
      const savedTimezone =
        typeof userPrefs.timezone === "string" && userPrefs.timezone
          ? userPrefs.timezone
          : null;

      const nowIso = new Date().toISOString();
      // Anchor for relative-time resolution: message tz > saved pref > config default.
      const timezone = state.timezone ?? savedTimezone ?? deps.defaultTimezone;
      const messages = [
        new SystemMessage(
          schedulePrompts.parseIntentPrompt({ nowIso, timezone }),
        ),
        new HumanMessage(state.userMessage),
      ];
      const extracted = await deps.llmService.extract(
        scheduleIntentSchema,
        messages,
        "schedule_intent",
      );

      deps.logger.info({ extracted }, "parse-intent result");

      // Contact/preference intents run their own focused extraction in their nodes.
      if (extracted.intent === "save_contact") {
        return {
          intent: extracted.intent,
          userPrefs,
          _nextNode: NODES.saveContact,
        };
      }
      if (extracted.intent === "set_preference") {
        return {
          intent: extracted.intent,
          userPrefs,
          _nextNode: NODES.savePreference,
        };
      }
      if (extracted.intent === "list_preferences") {
        return {
          intent: extracted.intent,
          userPrefs,
          _nextNode: NODES.listPreferences,
        };
      }

      // Schedule lookup — read-only; no clarification round (the node defaults
      // a missing window to the coming days).
      if (extracted.intent === "lookup_schedule") {
        return {
          intent: extracted.intent,
          attendee: extracted.attendee ?? state.attendee,
          timezone: extracted.timezone ?? state.timezone ?? savedTimezone,
          rangeStartIso: extracted.rangeStartIso,
          rangeEndIso: extracted.rangeEndIso,
          userPrefs,
          _nextNode: NODES.lookupSchedule,
        };
      }

      // Not a scheduling request — end with a failure result.
      if (extracted.intent === "unsupported") {
        return {
          intent: extracted.intent,
          result: {
            status: "failed" as const,
            summary: "This does not look like a meeting-scheduling request.",
          },
          _nextNode: NODES.finalize,
        };
      }

      const durationMinutes =
        extracted.durationMinutes ?? state.durationMinutes ?? DEFAULT_DURATION_MINUTES;
      // Carry forward anything already known (e.g. across a clarification round-trip).
      const attendee = extracted.attendee ?? state.attendee;
      const attendeeEmail = extracted.attendeeEmail ?? state.attendeeEmail;
      const timeframe = extracted.timeframe ?? state.timeframe;
      const requestedStartIso =
        extracted.requestedStartIso ?? state.requestedStartIso;
      const location = extracted.location ?? state.location;
      const shared = {
        intent: extracted.intent,
        attendee,
        attendeeEmail,
        additionalAttendeeEmails:
          extracted.additionalAttendeeEmails ?? state.additionalAttendeeEmails,
        attendeeTimezone: extracted.attendeeTimezone ?? state.attendeeTimezone,
        durationMinutes,
        timezone: extracted.timezone ?? state.timezone ?? savedTimezone,
        timeframe,
        requestedStartIso,
        location,
        meetingType: extracted.meetingType ?? state.meetingType,
        videoLink: extracted.videoLink ?? state.videoLink,
        notes: extracted.notes ?? state.notes,
        oneOffOverride: extracted.oneOffOverride ?? state.oneOffOverride,
        userPrefs,
      };
      // A concrete requested time counts as "when" even without a natural-language timeframe.
      const missing = !attendee || (!timeframe && !requestedStartIso);

      // Ask for missing info, but only up to MAX_CLARIFY_ATTEMPTS to avoid loops.
      if (
        missing &&
        extracted.clarificationQuestion &&
        state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
      ) {
        return {
          ...shared,
          clarificationQuestion: extracted.clarificationQuestion,
          _nextNode: NODES.askClarification,
        };
      }

      // Still missing required info after retries — give up cleanly.
      if (missing) {
        return {
          intent: extracted.intent,
          result: {
            status: "failed" as const,
            summary: "Not enough information to schedule the meeting.",
          },
          _nextNode: NODES.finalize,
        };
      }

      // Resolve the attendee against the contacts book before searching times.
      return {
        ...shared,
        clarificationQuestion: null,
        _nextNode: NODES.resolveContact,
      };
    },
  };
}
