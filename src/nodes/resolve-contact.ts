import type { ScheduleStateType } from "@/graphs/schedule.state";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  NODES,
  type ScheduleDeps,
} from "./shared";

/**
 * Resolve the attendee against the Google Drive contacts book (mirrors the Agent's
 * `contacts_lookup` → `contacts_save` flow). Never fabricates an email:
 *  - 1 hit          → use that email.
 *  - 0 hits + email → save the new contact, proceed.
 *  - 0 hits, no email (or ambiguous) → ask the user (clarification), then save on resume.
 */
export function makeResolveContactNode(deps: ScheduleDeps) {
  return {
    name: NODES.resolveContact,
    node: async (state: ScheduleStateType) => {
      const attendee = state.attendee ?? "";
      emitProgress(
        deps,
        state.threadId,
        "resolve_contact",
        `Looking up ${attendee}...`,
      );

      try {
        const auth = await deps.resolveAuth(state.tenantId);
        const matches = await deps.contactsTool.lookup(auth, attendee);

        // Unique hit — use its email (unless the user explicitly supplied a different one).
        if (matches.length === 1 && !state.attendeeEmail) {
          return {
            attendeeEmail: matches[0].email,
            _nextNode: NODES.searchCalendar,
          };
        }

        // We have an email (from the message or a reply): save/update the contact and proceed.
        if (state.attendeeEmail) {
          const save = await deps.contactsTool.save(auth, {
            name: attendee,
            email: state.attendeeEmail,
            timezone: state.timezone ?? undefined,
          });
          deps.logger.info(
            { attendee, save: save.action },
            "resolve-contact saved",
          );
          return { contactSaved: true, _nextNode: NODES.searchCalendar };
        }

        // No email yet — ask the user (bounded to avoid loops).
        if (state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
          const question =
            matches.length > 1
              ? `I found more than one contact named ${attendee}. What's their email address?`
              : `I couldn't find ${attendee} in your contacts. What's their email address?`;
          return {
            clarificationQuestion: question,
            _nextNode: NODES.askClarification,
          };
        }

        return {
          result: {
            status: "failed" as const,
            summary: `Could not determine an email for ${attendee}.`,
          },
          _nextNode: NODES.finalize,
        };
      } catch (err) {
        deps.logger.error({ err }, "resolve-contact failed");
        return {
          result: {
            status: "failed" as const,
            summary:
              "Could not access the contacts book. Please try again later.",
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
