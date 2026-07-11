import { withRetry } from "@/commons";
import type { AssistantStateType } from "@/graphs/assistant.state";
import type { AssistantWorkflowOutcome } from "@/schemas";
// Concrete module (not the `@/services` barrel) so Studio dev harnesses that load
// this node do not pull in kafka.service.ts and the native Kafka addon.
import {
  agentKeyOf,
  enablementKeyOf,
  type Workflow,
} from "@/services/workflow-runner";
import { ToolMessage, type AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ASSISTANT_NODES, emitProgress, type AssistantDeps } from "./shared";

/**
 * Workflow tools offered to the assistant. Schemas carry ONLY the user's request —
 * chatId/tenantId/attachments come from state, never from the model. The `tool()`
 * funcs are placeholders: execution happens in this node, against the real graphs.
 */
export const assistantWorkflowTools = [
  tool(async () => "", {
    name: "schedule_meeting",
    description: [
      "Schedule, reschedule, or cancel a meeting, or look up the user's own calendar,",
      "schedule, or availability. Do NOT use it for general questions about calendars,",
      "time zones, productivity, or meeting etiquette.",
    ].join(" "),
    schema: z.object({
      request: z
        .string()
        .describe("The user's scheduling request, with every detail they gave"),
    }),
  }),
  tool(async () => "", {
    name: "create_invoice",
    description: [
      "Create a sales invoice or supplier bill in Xero from the user's request and any",
      "attached files. Do NOT use it for questions about invoicing concepts, accounting,",
      "or tax — answer those directly.",
    ].join(" "),
    schema: z.object({
      request: z
        .string()
        .describe("The user's invoicing request, with every detail they gave"),
    }),
  }),
];

const workflowOfTool: Record<string, Workflow> = {
  schedule_meeting: "schedule",
  create_invoice: "invoice",
};

/** What the model sees as the tool result. */
function toolResultFor(outcome: AssistantWorkflowOutcome): unknown {
  switch (outcome.kind) {
    case "clarification":
      return { status: "needs_clarification", question: outcome.question };
    case "approval":
      return {
        status: "needs_approval",
        message: outcome.message,
        approval: outcome.approval,
      };
    case "agent_disabled":
      return {
        status: "agent_disabled",
        message: `The ${agentKeyOf[outcome.workflow]} agent is currently disabled for this workspace.`,
      };
    case "result":
      return outcome.result;
  }
}

/** Which outcome the turn reports when several tools ran: a pause dominates, then a result. */
const OUTCOME_PRIORITY: Record<AssistantWorkflowOutcome["kind"], number> = {
  clarification: 3,
  approval: 3,
  result: 2,
  agent_disabled: 1,
};

/**
 * Execute the workflow tool calls issued by the assistant. Each workflow runs on
 * its own thread (`<workflow>:<chatId>`); an interrupt inside it surfaces here as
 * a needs_clarification/needs_approval tool result instead of pausing this graph.
 */
export function makeAssistantExecuteToolsNode(deps: AssistantDeps) {
  return {
    name: ASSISTANT_NODES.executeTools,
    node: async (state: AssistantStateType) => {
      const last = state.messages.at(-1) as AIMessage | undefined;
      const toolCalls = last?.tool_calls ?? [];
      const messages: ToolMessage[] = [];
      let outcome: AssistantWorkflowOutcome | null = null;
      // A paused workflow must not be followed by more workflow invocations this turn.
      let paused = false;

      for (const call of toolCalls) {
        const workflow = workflowOfTool[call.name];
        const callId = call.id ?? "";

        if (!workflow) {
          messages.push(
            new ToolMessage(
              JSON.stringify({
                status: "error",
                message: `Unknown tool: ${call.name}`,
              }),
              callId,
            ),
          );
          continue;
        }
        if (paused) {
          messages.push(
            new ToolMessage(
              JSON.stringify({
                status: "skipped",
                message: "Another workflow is awaiting the user's reply.",
              }),
              callId,
            ),
          );
          continue;
        }
        if (!state.enablement[enablementKeyOf[workflow]]) {
          const disabled: AssistantWorkflowOutcome = {
            kind: "agent_disabled",
            workflow,
          };
          outcome ??= disabled;
          messages.push(
            new ToolMessage(JSON.stringify(toolResultFor(disabled)), callId),
          );
          deps.logger.info(
            { chatId: state.chatId, workflow },
            "agent disabled — gated",
          );
          continue;
        }

        emitProgress(deps, state.chatId, call.name, "Working on it...");
        deps.audit.runStarted({
          threadId: state.chatId,
          workflow,
          userId: state.userId || undefined,
        });
        const request = String(
          (call.args as { request?: unknown })?.request ?? "",
        );
        let run: AssistantWorkflowOutcome;
        try {
          run = (await withRetry(
            () =>
              deps.runWorkflow(workflow, state.chatId, {
                threadId: state.chatId,
                tenantId: state.tenantId,
                userMessage: request,
                ...(workflow === "invoice" && state.attachments.length
                  ? { attachments: state.attachments }
                  : {}),
              }),
            { attempts: 2 },
          )) as AssistantWorkflowOutcome;
        } catch (err) {
          // A crashed workflow must not kill the whole assistant run — surface
          // it to the model as an error tool result and keep going.
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error(
            { err, chatId: state.chatId, workflow },
            "workflow tool failed",
          );
          messages.push(
            new ToolMessage(
              JSON.stringify({ status: "error", message }),
              callId,
            ),
          );
          continue;
        }

        if (
          !outcome ||
          OUTCOME_PRIORITY[run.kind] >= OUTCOME_PRIORITY[outcome.kind]
        ) {
          outcome = run;
        }
        // A paused workflow is what the user must answer next.
        if (run.kind === "clarification" || run.kind === "approval") {
          paused = true;
        }
        messages.push(
          new ToolMessage(JSON.stringify(toolResultFor(run)), callId),
        );
      }

      return { messages, outcome, _nextNode: ASSISTANT_NODES.callModel };
    },
  };
}
