import type { ScheduleStateType } from "@/graphs/schedule.state";
import type { Contact } from "@/tools";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  NODES,
  type ScheduleDeps,
} from "./shared";

type Candidate = {
  name: string;
  email: string;
  company?: string | null;
  timezone?: string | null;
};

/** "1. Sarah Lim — Acme <sarah@acme.com>" lines for a disambiguation question. */
function listCandidates(matches: Candidate[]): string {
  return matches
    .map(
      (c, i) =>
        `${i + 1}. ${c.name}${c.company ? ` — ${c.company}` : ""} <${c.email}>`,
    )
    .join("\n");
}

/**
 * Deterministically match the principal's disambiguation reply against the
 * stored candidates: a number ("2", "option 2"), an email, or a company/name
 * substring. Null when nothing matches unambiguously — never guess.
 */
function pickCandidate(
  reply: string,
  candidates: Candidate[],
): Candidate | null {
  const r = reply.trim().toLowerCase();
  if (!r) return null;
  const numMatch = /(?:^|option\s*|number\s*)(\d+)\s*$/.exec(r);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    return candidates[idx] ?? null;
  }
  const byEmail = candidates.filter((c) => r.includes(c.email.toLowerCase()));
  if (byEmail.length === 1) return byEmail[0];
  const byCompany = candidates.filter(
    (c) => c.company && r.includes(c.company.toLowerCase()),
  );
  if (byCompany.length === 1) return byCompany[0];
  const byName = candidates.filter((c) => r.includes(c.name.toLowerCase()));
  if (byName.length === 1) return byName[0];
  return null;
}

/**
 * Resolve the attendee against the Google Drive contacts book (mirrors the Agent's
 * `contacts_lookup` → `contacts_save` flow). Never fabricates an email:
 *  - 1 hit          → use that email (and its timezone as the attendee-tz fallback).
 *  - >1 hits        → list them (org + email) and ask which; a reply is matched
 *                     deterministically against the stored candidates.
 *  - 0 hits + email → save the new contact, proceed.
 *  - 0 hits, no email → ask the user (clarification), then save on resume.
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

        // Re-entry after a "which one?" question — the reply is the last line
        // of the (clarification-enriched) message.
        if (state.contactCandidates?.length && !state.attendeeEmail) {
          const reply = state.userMessage.split("\n").at(-1) ?? "";
          const picked = pickCandidate(reply, state.contactCandidates);
          if (picked) {
            return {
              attendeeEmail: picked.email,
              attendeeTimezone: state.attendeeTimezone ?? picked.timezone,
              contactCandidates: null,
              _nextNode: NODES.searchCalendar,
            };
          }
        }

        const matches = await deps.contactsTool.lookup(auth, attendee);

        // Unique hit — use its email (unless the user explicitly supplied a different one).
        if (matches.length === 1 && !state.attendeeEmail) {
          return {
            attendeeEmail: matches[0].email,
            attendeeTimezone: state.attendeeTimezone ?? matches[0].timezone,
            contactCandidates: null,
            _nextNode: NODES.searchCalendar,
          };
        }

        // We have an email (from the message or a reply): save/update the contact and proceed.
        if (state.attendeeEmail) {
          const contact: Contact = {
            name: attendee,
            email: state.attendeeEmail,
            timezone: state.attendeeTimezone ?? state.timezone ?? undefined,
          };
          const save = await deps.contactsTool.save(auth, contact);
          if (
            save.action === "needs_disambiguation" &&
            state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS
          ) {
            return {
              contactCandidates: save.matches,
              clarificationQuestion: `I have more than one contact named ${attendee}:\n${listCandidates(save.matches)}\nWhich one should I update? (reply with a number or email)`,
              _nextNode: NODES.askClarification,
            };
          }
          deps.logger.info(
            { attendee, save: save.action },
            "resolve-contact saved",
          );
          return {
            contactSaved: true,
            contactCandidates: null,
            _nextNode: NODES.searchCalendar,
          };
        }

        // Multiple hits — show org + email and ask which; never guess.
        if (matches.length > 1) {
          if (state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
            return {
              contactCandidates: matches,
              clarificationQuestion: `I found more than one contact named ${attendee}:\n${listCandidates(matches)}\nWhich one do you mean? (reply with a number or email)`,
              _nextNode: NODES.askClarification,
            };
          }
        } else if (state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
          // No hits, no email yet — ask for the address (bounded to avoid loops).
          return {
            clarificationQuestion: `I couldn't find ${attendee} in your contacts. What's their email address?`,
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
