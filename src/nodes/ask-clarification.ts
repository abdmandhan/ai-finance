import type { ScheduleStateType } from '@/graphs/schedule.state';
import { interrupt } from '@langchain/langgraph';
import { NODES, type InterruptPayload, type ResumeInput, type ScheduleDeps } from './shared';

/**
 * Pause the graph and ask the user for missing info. Resumes with the reply,
 * which is folded into the message and re-parsed by the parse-intent node.
 */
export function makeAskClarificationNode(deps: ScheduleDeps) {
  return {
    name: NODES.askClarification,
    node: async (state: ScheduleStateType) => {
      const question = state.clarificationQuestion ?? 'Could you provide more details?';

      const payload: InterruptPayload = { kind: 'clarification', message: question };
      const reply = interrupt<InterruptPayload, ResumeInput>(payload);

      deps.logger.info({ reply }, 'clarification reply');
      const answer = reply.reply ?? '';

      return {
        userMessage: `${state.userMessage}\n${answer}`,
        clarificationQuestion: null,
        clarifyAttempts: state.clarifyAttempts + 1,
        _nextNode: undefined,
      };
    },
  };
}
