import type { AssistantStateType } from "@/graphs/assistant.state";
import { assistantPrompts } from "@/prompts";
import { SystemMessage, type AIMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";
import { assistantWorkflowTools } from "./assistant-execute-tools";
import { ASSISTANT_NODES, emitProgress, type AssistantDeps } from "./shared";

/**
 * The main assistant turn: answer directly, or pick a workflow tool. Tools are
 * withheld when the turn only relays a paused/finished workflow's output, so a
 * paused graph is never double-invoked.
 */
export function makeAssistantCallModelNode(deps: AssistantDeps) {
  return {
    name: ASSISTANT_NODES.callModel,
    node: async (state: AssistantStateType) => {
      emitProgress(deps, state.chatId, "assistant", "Thinking...");

      const system = [
        new SystemMessage(
          assistantPrompts.systemPrompt({
            nowIso: new Date().toISOString(),
            timezone: deps.defaultTimezone,
          }),
        ),
      ];
      if (state.workflowReport) {
        system.push(
          new SystemMessage(
            assistantPrompts.workflowReportPrompt(state.workflowReport),
          ),
        );
      }
      const history = state.messages.slice(-deps.maxHistoryMessages);

      // Relay turns get no tools: after a workflow paused (clarification/approval),
      // when a tool was gated, or when phrasing a finished workflow's report.
      const relayOnly =
        Boolean(state.workflowReport) ||
        (state.outcome != null && state.outcome.kind !== "result");

      const response: AIMessage = await deps.llmService.chat(
        [...system, ...history],
        relayOnly ? undefined : { tools: assistantWorkflowTools },
      );

      return {
        messages: [response],
        _nextNode: response.tool_calls?.length
          ? ASSISTANT_NODES.executeTools
          : END,
      };
    },
  };
}
