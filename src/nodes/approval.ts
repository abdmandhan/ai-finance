import type { ScheduleStateType } from '@/graphs/schedule.state';
import { interrupt } from '@langchain/langgraph';
import { NODES, type InterruptPayload, type ResumeInput, type ScheduleDeps } from './shared';

/**
 * Human-approval gate. Creating a calendar event is a high-risk action, so the
 * graph pauses here (durably, via the checkpointer) until the user approves.
 * The structured `approval` block becomes `output.approvalData` on chat.outbound,
 * which the backend renders as a pending approval.
 */
export function makeApprovalNode(deps: ScheduleDeps) {
  return {
    name: NODES.approval,
    node: async (state: ScheduleStateType) => {
      const slot = state.selectedSlot;
      const message = `Create a ${state.durationMinutes}-minute meeting with ${state.attendee} starting ${slot?.start}?`;

      const payload: InterruptPayload = {
        kind: 'approval',
        message,
        approval: {
          name: 'create_calendar_event',
          provider: 'calendar',
          items: [{ ref: slot?.start ?? 'slot', label: `Meeting with ${state.attendee}` }],
          args: {
            attendee: state.attendee,
            slot,
            durationMinutes: state.durationMinutes,
          },
        },
      };
      const decision = interrupt<InterruptPayload, ResumeInput>(payload);

      const approved = decision.approved === true;
      deps.logger.info({ approved }, 'approval decision');

      if (!approved) {
        return {
          approved: false,
          result: {
            status: 'cancelled' as const,
            summary: 'Meeting creation was declined.',
          },
          _nextNode: NODES.finalize,
        };
      }

      return { approved: true, _nextNode: NODES.createEvent };
    },
  };
}
