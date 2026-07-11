import type { AssistantWorkflowOutcome, OutboundOutput } from "@/schemas";
import { agentKeyOf } from "@/services";

/**
 * Map a workflow outcome + user-facing answer to the outbound `output` object.
 * Encodes the exact contract the App expects (same as the legacy `drive()`):
 *   - no outcome (pure conversation)  -> intent "ok"
 *   - agent_disabled                  -> intent "not_supported" + agentKey
 *   - clarification                   -> intent "needs_clarification"
 *   - approval (pending)              -> intent "call_tool" + pending approvalData
 *   - result created                  -> intent "call_tool" + completed approvalData
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
      const created = result.status === "created";
      const answered = result.status === "answered";
      // Post-hoc approvalData record for a completed action (calendar event or authorised invoice).
      const ref = result.eventId ?? result.invoiceId;
      const approvalData =
        created && ref
          ? [
              {
                name:
                  outcome.workflow === "invoice"
                    ? "xero_authorise_invoice"
                    : "create_calendar_event",
                provider: outcome.workflow === "invoice" ? "xero" : "calendar",
                items: [
                  { ref, label: result.summary, status: "completed" as const },
                ],
              },
            ]
          : undefined;
      return {
        answer,
        intent: created ? "call_tool" : answered ? "ok" : "not_supported",
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
      const label = outcome.workflow === "invoice" ? "Invoicing" : "Scheduling";
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
