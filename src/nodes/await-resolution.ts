import type { ScheduleStateType } from "@/graphs/schedule.state";
import { findFreeSlots, formatSlotDual, formatEventLine } from "@/commons";
import { schedulePrompts } from "@/prompts";
import { resolutionSchema } from "@/schemas";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import {
  MAX_CLARIFY_ATTEMPTS,
  mergePrefs,
  NODES,
  type InterruptPayload,
  type ResumeInput,
  type ScheduleDeps,
} from "./shared";

/**
 * Hold a conflict/travel/preference/no-slot proposal open until the principal
 * picks a resolution, then execute exactly what they chose — pick an offered
 * option, accept the requested time anyway, shorten it, move the conflicting
 * event instead, name a new time, widen the search, or cancel. Nothing is
 * booked or moved before the reply arrives.
 *
 * NOTE: contains `interrupt()` — the node re-runs from the top on each resume,
 * so everything before the interrupt is pure (message building only).
 */
export function makeAwaitResolutionNode(deps: ScheduleDeps) {
  return {
    name: NODES.awaitResolution,
    node: async (state: ScheduleStateType) => {
      const proposal = state.proposal;
      if (!proposal) {
        return {
          result: {
            status: "failed" as const,
            summary: "No pending proposal to resolve.",
          },
          _nextNode: NODES.finalize,
        };
      }

      const principalTz = state.timezone ?? deps.defaultTimezone;
      const optionLines = proposal.options.map(
        (o, i) =>
          `${i + 1}. ${formatSlotDual(o, principalTz, state.attendeeTimezone)}`,
      );
      const retryPrefix =
        state.resolutionAttempts > 0
          ? "Sorry, I didn't catch that — please pick one of the numbered options, or tell me to accept, shorten, reschedule, widen, or cancel.\n\n"
          : "";
      const message = [
        retryPrefix + proposal.reason,
        ...(optionLines.length ? ["", ...optionLines] : []),
      ].join("\n");

      const payload: InterruptPayload = { kind: "proposal", message };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);
      const replyText = reply.reply ?? "";

      try {
        const resolution = await deps.llmService.extract(
          resolutionSchema,
          [
            new SystemMessage(
              schedulePrompts.resolutionPrompt({
                nowIso: new Date().toISOString(),
                timezone: principalTz,
                reason: proposal.reason,
                options: proposal.options.map((o) =>
                  formatSlotDual(o, principalTz, state.attendeeTimezone),
                ),
                conflictSummaries: proposal.conflictEvents.map((c) =>
                  formatEventLine(
                    { ...c, location: c.location ?? undefined },
                    principalTz,
                  ),
                ),
              }),
            ),
            new HumanMessage(replyText),
          ],
          "resolution",
        );
        deps.logger.info({ resolution }, "await-resolution parsed");

        switch (resolution.action) {
          case "pick_option": {
            const picked =
              resolution.optionIndex != null
                ? proposal.options[resolution.optionIndex - 1]
                : undefined;
            if (picked) {
              return {
                selectedSlot: picked,
                proposal: null,
                _nextNode: NODES.createEvent,
              };
            }
            break; // fall through to the unclear handling below
          }

          case "accept_anyway": {
            if (proposal.requestedSlot) {
              return {
                selectedSlot: proposal.requestedSlot,
                proposal: null,
                _nextNode: NODES.createEvent,
              };
            }
            break;
          }

          case "shorten": {
            if (resolution.newDurationMinutes && proposal.requestedSlot) {
              // Keep the start, shrink the duration, and revalidate from scratch.
              return {
                durationMinutes: resolution.newDurationMinutes,
                requestedStartIso: proposal.requestedSlot.start,
                proposal: null,
                _nextNode: NODES.searchCalendar,
              };
            }
            break;
          }

          case "reschedule_existing": {
            const needle = (resolution.targetEventSummary ?? "").toLowerCase();
            const target =
              proposal.conflictEvents.find((c) =>
                c.summary.toLowerCase().includes(needle),
              ) ??
              (proposal.conflictEvents.length === 1
                ? proposal.conflictEvents[0]
                : undefined);
            if (target && proposal.requestedSlot) {
              const auth = await deps.resolveAuth(state.tenantId);
              // Find a same-day replacement for the moved event, treating the
              // requested meeting as busy so they can't collide.
              const dayEnd = new Date(
                Date.parse(target.start) + 24 * 3_600_000,
              ).toISOString();
              const dayEvents = await deps.calendarTool.listEvents(
                auth,
                target.start,
                dayEnd,
              );
              const busy = [
                ...dayEvents
                  .filter((e) => e.eventId !== target.eventId)
                  .map((e) => ({ start: e.start, end: e.end })),
                proposal.requestedSlot,
              ];
              const targetDurMin = Math.round(
                (Date.parse(target.end) - Date.parse(target.start)) / 60_000,
              );
              const [replacement] = findFreeSlots(
                busy,
                proposal.requestedSlot.end,
                dayEnd,
                targetDurMin,
                mergePrefs(
                  { ...deps.schedulingPrefs, timezone: principalTz },
                  state.userPrefs,
                ),
                1,
              );
              if (replacement) {
                await deps.calendarTool.updateEvent(auth, target.eventId, {
                  start: replacement.start,
                  end: replacement.end,
                });
                return {
                  selectedSlot: proposal.requestedSlot,
                  proposal: null,
                  notes: [
                    state.notes,
                    `(Moved "${target.summary}" to ${formatSlotDual(replacement, principalTz)}.)`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  _nextNode: NODES.createEvent,
                };
              }
            }
            break;
          }

          case "new_time": {
            if (resolution.newStartIso) {
              return {
                requestedStartIso: resolution.newStartIso,
                proposal: null,
                _nextNode: NODES.searchCalendar,
              };
            }
            break;
          }

          case "widen": {
            return {
              searchWindowDays: (state.searchWindowDays ?? 14) + 14,
              requestedStartIso: null,
              proposal: null,
              _nextNode: NODES.searchCalendar,
            };
          }

          case "cancel": {
            return {
              result: {
                status: "cancelled" as const,
                summary: "Okay — I won't book anything.",
              },
              proposal: null,
              _nextNode: NODES.finalize,
            };
          }

          case "unclear":
          default:
            break;
        }
      } catch (err) {
        if (isGraphBubbleUp(err)) throw err;
        deps.logger.error({ err }, "await-resolution extract failed");
      }

      // Unparseable / incomplete reply — re-ask, bounded; then hand the options
      // back as a plain proposal so the driver can at least show them.
      if (state.resolutionAttempts < MAX_CLARIFY_ATTEMPTS) {
        return {
          resolutionAttempts: state.resolutionAttempts + 1,
          _nextNode: NODES.awaitResolution,
        };
      }
      return {
        suggestedSlots: proposal.options,
        result: {
          status: "proposed" as const,
          summary: proposal.reason,
          suggestedSlots: proposal.options,
        },
        proposal: null,
        _nextNode: NODES.finalize,
      };
    },
  };
}
