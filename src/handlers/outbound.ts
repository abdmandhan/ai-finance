import type { AssistantWorkflowOutcome, OutboundOutput } from "@/schemas";
import { agentKeyOf, workflowDisplayNameOf } from "@/services";

/**
 * Map a workflow outcome + user-facing answer to the outbound `output` object.
 * Encodes the exact contract the App expects (same as the legacy `drive()`):
 *   - no outcome (pure conversation)  -> intent "ok"
 *   - agent_disabled                  -> intent "not_supported" + agentKey
 *   - clarification                   -> intent "needs_clarification"
 *   - approval (pending)              -> intent "call_tool" + pending approvalData
 *   - result with completedApproval   -> intent "call_tool" + completed approvalData
 *   - result proposed                 -> intent "needs_clarification"
 *   - result answered                 -> intent "ok"
 *   - anything else                   -> intent "not_supported"
 */
export function outcomeToOutput(
  outcome: AssistantWorkflowOutcome | null | undefined,
  answer: string,
): OutboundOutput {
  if (!outcome) return { answer, intent: "ok" };

  const agentKey = agentKeyOf[outcome.workflow];

  switch (outcome.kind) {
    case "agent_disabled":
      return { answer, intent: "not_supported", agentKey };
    case "clarification":
      return { answer, intent: "needs_clarification", agentKey };
    case "approval":
      return {
        answer,
        intent: "call_tool",
        agentKey,
        approvalData: [
          {
            ...outcome.approval,
            items: outcome.approval.items.map((i) => ({
              ...i,
              status: "pending" as const,
            })),
          },
        ],
      };
    case "result": {
      const result = outcome.result;
      if (result.status === "proposed") {
        return { answer, intent: "needs_clarification", agentKey };
      }
      const answered = result.status === "answered";
      const completed = result.completedApproval;
      const approvalData = completed
        ? [
            {
              name: completed.name,
              provider: completed.provider,
              items: completed.items?.length
                ? completed.items.map((item) => ({
                    ...item,
                    status: item.status ?? ("completed" as const),
                  }))
                : [
                    {
                      ref: completed.ref,
                      label: completed.label ?? result.summary,
                      status: "completed" as const,
                    },
                  ],
            },
          ]
        : undefined;
      return {
        answer,
        intent: completed ? "call_tool" : answered ? "ok" : "not_supported",
        agentKey,
        ...(approvalData ? { approvalData } : {}),
      };
    }
  }
}

/**
 * Legacy-style fallback answer text for an outcome, used when the assistant
 * produced no text (or is bypassed on a re-interrupt during resume).
 */
export function defaultAnswerFor(outcome: AssistantWorkflowOutcome): string {
  switch (outcome.kind) {
    case "clarification":
      return outcome.question;
    case "approval":
      return outcome.message;
    case "agent_disabled": {
      const label = workflowDisplayNameOf[outcome.workflow];
      return `The ${label} agent is currently disabled for your workspace.`;
    }
    case "result": {
      const result = outcome.result;
      if (result.status === "proposed") {
        const slots = result.suggestedSlots ?? [];
        const list = slots.length
          ? "\nSome open times:\n" + slots.map((s) => `- ${s.start}`).join("\n")
          : "";
        return `${result.summary}${list}`;
      }
      return result.status === "created" && result.htmlLink
        ? `${result.summary}\n${result.htmlLink}`
        : result.summary;
    }
  }
}
