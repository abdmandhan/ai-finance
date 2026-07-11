import type { ScheduleStateType } from "@/graphs/schedule.state";
import { formatSlotDual } from "@/commons";
import { emitProgress, NODES, type ScheduleDeps } from "./shared";

/**
 * Create the calendar event immediately — no approval gate (mirrors the Agent, which
 * writes the event on the calendar the moment the tool runs). The approval record is
 * emitted post-hoc by the runtime driver, not held here.
 */
export function makeCreateEventNode(deps: ScheduleDeps) {
  return {
    name: NODES.createEvent,
    node: async (state: ScheduleStateType) => {
      if (!state.selectedSlot) {
        return {
          result: {
            status: "failed" as const,
            summary: "No slot selected to create.",
          },
          _nextNode: NODES.finalize,
        };
      }

      emitProgress(
        deps,
        state.threadId,
        "create_event",
        "Creating the meeting...",
      );
      const summary = `Meeting with ${state.attendee}`;

      try {
        const auth = await deps.resolveAuth(state.tenantId);

        const attendees = [
          ...(state.attendeeEmail
            ? [{ email: state.attendeeEmail, name: state.attendee ?? undefined }]
            : []),
          ...(state.additionalAttendeeEmails ?? []).map((email) => ({ email })),
        ];

        // Video → explicit link in the description, or ask Google for a Meet link.
        // Physical → address as location (drives later travel-time checks).
        const isVideo = state.meetingType === "video" || !!state.videoLink;
        const descriptionParts = [
          ...(state.videoLink ? [`Join: ${state.videoLink}`] : []),
          ...(state.notes ? [state.notes] : []),
        ];

        const { eventId, htmlLink, meetLink } =
          await deps.calendarTool.createEvent(auth, {
            summary,
            start: state.selectedSlot.start,
            end: state.selectedSlot.end,
            timeZone: state.timezone ?? undefined,
            location: isVideo ? undefined : (state.location ?? undefined),
            description: descriptionParts.length
              ? descriptionParts.join("\n\n")
              : undefined,
            createMeetLink: isVideo && !state.videoLink,
            attendees: attendees.length ? attendees : undefined,
          });

        const when = formatSlotDual(
          state.selectedSlot,
          state.timezone ?? deps.defaultTimezone,
          state.attendeeTimezone,
        );
        const where = isVideo
          ? ` (video: ${state.videoLink ?? meetLink ?? "link on the invite"})`
          : state.location
            ? ` at ${state.location}`
            : "";
        return {
          result: {
            status: "created" as const,
            eventId,
            htmlLink,
            summary: `${summary} scheduled for ${when}${where}`,
          },
          _nextNode: NODES.notify,
        };
      } catch (err) {
        deps.logger.error({ err }, "create-event failed");
        return {
          result: {
            status: "failed" as const,
            summary:
              "Could not create the calendar event. Please try again later.",
          },
          _nextNode: NODES.finalize,
        };
      }
    },
  };
}
