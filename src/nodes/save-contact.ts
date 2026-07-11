import type { ScheduleStateType } from "@/graphs/schedule.state";
import { contactExtractionSchema } from "@/schemas";
import { schedulePrompts } from "@/prompts";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import type { Contact } from "@/tools";
import {
  emitProgress,
  MAX_CLARIFY_ATTEMPTS,
  NODES,
  type InterruptPayload,
  type ResumeInput,
  type ScheduleDeps,
} from "./shared";

/**
 * Save or update a contact on the principal's explicit request ("save Sarah Lim
 * sarah@acme.com to contacts") or from pasted text/a signature. An email CHANGE
 * for an existing contact is confirmed via interrupt before writing.
 *
 * NOTE: contains `interrupt()` — the node re-runs from the top on resume, so the
 * extraction is repeated and no write happens before the confirmation returns.
 */
export function makeSaveContactNode(deps: ScheduleDeps) {
  return {
    name: NODES.saveContact,
    node: async (state: ScheduleStateType) => {
      emitProgress(deps, state.threadId, "save_contact", "Saving contact...");

      try {
        const extraction = await deps.llmService.extract(
          contactExtractionSchema,
          [
            new SystemMessage(schedulePrompts.contactExtractPrompt()),
            new HumanMessage(state.userMessage),
          ],
          "contact",
        );

        if (!extraction.name || !extraction.email) {
          if (state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
            return {
              clarificationQuestion:
                extraction.clarificationQuestion ??
                "What's the contact's name and email address?",
              _nextNode: NODES.askClarification,
            };
          }
          return {
            result: {
              status: "failed" as const,
              summary: "Could not determine the contact's name and email.",
            },
            _nextNode: NODES.finalize,
          };
        }

        const auth = await deps.resolveAuth(state.tenantId);
        const contact: Contact = {
          name: extraction.name,
          email: extraction.email,
          company: extraction.company ?? undefined,
          timezone: extraction.timezone ?? undefined,
        };

        // Changing an existing contact's email → confirm before writing.
        if (extraction.isEmailUpdate) {
          const matches = await deps.contactsTool.lookup(auth, contact.name);
          const existing =
            matches.length === 1 &&
            matches[0].email.toLowerCase() !== contact.email.toLowerCase()
              ? matches[0]
              : null;
          if (existing) {
            const payload: InterruptPayload = {
              kind: "clarification",
              message: `Update ${existing.name}'s email from ${existing.email} to ${contact.email}? (yes/no)`,
            };
            const reply = interrupt<InterruptPayload, ResumeInput>(payload);
            if (!reply.approved) {
              return {
                result: {
                  status: "cancelled" as const,
                  summary: `Left ${existing.name}'s email as ${existing.email}.`,
                },
                _nextNode: NODES.finalize,
              };
            }
            // Merge onto the existing row by name (email differs by definition).
            const save = await deps.contactsTool.save(auth, contact);
            deps.logger.info(
              { name: contact.name, save: save.action },
              "save-contact email updated",
            );
            return {
              contactSaved: true,
              result: {
                status: "answered" as const,
                summary: `Updated ${contact.name}'s email to ${contact.email}.`,
              },
              _nextNode: NODES.finalize,
            };
          }
          if (matches.length > 1 && state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
            const list = matches
              .map(
                (c, i) =>
                  `${i + 1}. ${c.name}${c.company ? ` — ${c.company}` : ""} <${c.email}>`,
              )
              .join("\n");
            return {
              clarificationQuestion: `I have more than one contact named ${contact.name}:\n${list}\nWhich one's email should I update? (reply with their current email)`,
              _nextNode: NODES.askClarification,
            };
          }
          // No existing row (or same email) — fall through to a plain save.
        }

        const save = await deps.contactsTool.save(auth, contact);
        if (save.action === "needs_disambiguation") {
          if (state.clarifyAttempts < MAX_CLARIFY_ATTEMPTS) {
            const list = save.matches
              .map(
                (c, i) =>
                  `${i + 1}. ${c.name}${c.company ? ` — ${c.company}` : ""} <${c.email}>`,
              )
              .join("\n");
            return {
              clarificationQuestion: `I have more than one contact named ${contact.name}:\n${list}\nWhich one should I update? (reply with their current email)`,
              _nextNode: NODES.askClarification,
            };
          }
          return {
            result: {
              status: "failed" as const,
              summary: `Could not tell which ${contact.name} to update.`,
            },
            _nextNode: NODES.finalize,
          };
        }

        const org = contact.company ? ` (${contact.company})` : "";
        const verb = save.action === "updated" ? "Updated" : "Saved";
        return {
          contactSaved: true,
          result: {
            status: "answered" as const,
            summary: `${verb} ${contact.name} <${contact.email}>${org} in your contacts.`,
          },
          _nextNode: NODES.finalize,
        };
      } catch (err) {
        // interrupt() pauses by throwing — let it bubble to the runtime.
        if (isGraphBubbleUp(err)) throw err;
        deps.logger.error({ err }, "save-contact failed");
        return {
          result: {
            status: "failed" as const,
            summary: "Could not save the contact. Please try again later.",
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
