import type { AssistantWorkflowOutcome } from "@/schemas";

export type AssistantPublishPolicy = "always_publish" | "workflow_only";

export function shouldPublishAssistantOutbound(
  policy: AssistantPublishPolicy,
  outcome: AssistantWorkflowOutcome | null | undefined,
): boolean {
  if (policy === "always_publish") return true;
  return outcome != null;
}
