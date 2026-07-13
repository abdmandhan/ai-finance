import type { ILogger } from "@/commons";
import type { InterruptPayload } from "@/nodes";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { AgentEnablement } from "./agent-enablement";

/** The strict workflows this service can run. Each one is a compiled LangGraph graph. */
export type Workflow = "schedule" | "invoice" | "payment" | "expense" | "report";

/** Minimal graph surface the runner needs — avoids unioning the two giant compiled types. */
export interface RunnableGraph {
  invoke(input: unknown, config: RunnableConfig): Promise<unknown>;
  getState(config: RunnableConfig): Promise<unknown>;
}

/** Result shape produced by any workflow graph's finalize node. */
export interface GraphResult {
  status: string;
  summary: string;
  eventId?: string;
  htmlLink?: string;
  invoiceId?: string;
  paymentId?: string;
  creditNoteId?: string;
  bankTransactionId?: string;
  transferId?: string;
  remainingAmountDue?: number;
  period?: { from: string; to: string; label: string };
  basis?: string;
  suggestedSlots?: { start: string; end: string }[];
}

/**
 * Structured outcome of one workflow invoke/resume. Machine-to-machine: the
 * outbound Kafka `output` (intent/approvalData) is derived from this, while the
 * assistant only phrases the user-facing text.
 */
export type WorkflowOutcome =
  | { kind: "clarification"; workflow: Workflow; question: string }
  | {
      kind: "approval";
      workflow: Workflow;
      message: string;
      approval: {
        name: string;
        provider: string;
        items: { ref: string; label?: string }[];
      };
    }
  | { kind: "result"; workflow: Workflow; result: GraphResult };

/** `output.agentKey` label for each workflow. */
export const agentKeyOf: Record<Workflow, string> = {
  schedule: "scheduling",
  invoice: "invoicing",
  payment: "invoicing",
  expense: "expense",
  report: "invoicing",
};

/** Which enablement flag gates each workflow (the graph IS that agent). */
export const enablementKeyOf: Record<Workflow, keyof AgentEnablement> = {
  schedule: "scheduling",
  invoice: "invoicing",
  // Payments and read-only reports ride the invoicing flag: same Xero connection,
  // same accounting surface. Expense has its own backend flag.
  payment: "invoicing",
  expense: "expense",
  report: "invoicing",
};

/** Per-workflow thread namespace so graph checkpoints never collide on one chat. */
export function threadKey(workflow: Workflow, chatId: string): string {
  return `${workflow}:${chatId}`;
}

export function extractInterrupt(result: unknown): InterruptPayload | null {
  const interrupts = (result as { __interrupt__?: Array<{ value?: unknown }> })
    ?.__interrupt__;
  return (interrupts?.[0]?.value as InterruptPayload | undefined) ?? null;
}

/**
 * When a workflow graph is invoked from INSIDE another graph's node (the
 * assistant), LangGraph treats it as a nested run and an `interrupt()` in the
 * child THROWS a GraphInterrupt instead of returning `__interrupt__` — even
 * with an explicit thread config. The child's pause is already checkpointed on
 * its own thread, so the throw is just the delivery mechanism: unwrap it.
 */
function interruptFromError(err: unknown): InterruptPayload | null {
  const e = err as {
    name?: string;
    interrupts?: Array<{ value?: unknown }>;
  } | null;
  if (e?.name !== "GraphInterrupt") return null;
  return (e.interrupts?.[0]?.value as InterruptPayload | undefined) ?? null;
}

export function isAffirmative(text: string): boolean {
  return /^\s*(yes|y|approve|approved|ok|okay|confirm|confirmed|sure|do it|go ahead)\b/i.test(
    text,
  );
}

/** Run or resume one workflow graph and normalize its ending into a `WorkflowOutcome`. */
export type RunWorkflow = (
  workflow: Workflow,
  chatId: string,
  input: unknown,
) => Promise<WorkflowOutcome>;

export function createWorkflowRunner(deps: {
  graphs: Record<Workflow, RunnableGraph>;
  logger: ILogger;
}): RunWorkflow {
  return async function runWorkflow(workflow, chatId, input) {
    // Explicit config only — never the parent's — so the workflow keeps its own
    // thread. Top-level invokes surface the interrupt on the result; nested
    // invokes (assistant tool calls) deliver it as a GraphInterrupt throw.
    let raw: { result?: GraphResult } = {};
    let pending: InterruptPayload | null = null;
    try {
      raw = (await deps.graphs[workflow].invoke(input, {
        configurable: { thread_id: threadKey(workflow, chatId) },
      })) as { result?: GraphResult };
      pending = extractInterrupt(raw);
    } catch (err) {
      pending = interruptFromError(err);
      if (!pending) throw err;
    }
    if (pending?.kind === "approval") {
      return {
        kind: "approval",
        workflow,
        message: pending.message,
        approval: pending.approval,
      };
    }
    if (pending) {
      return { kind: "clarification", workflow, question: pending.message };
    }
    return {
      kind: "result",
      workflow,
      result: raw.result ?? { status: "failed", summary: "No result produced." },
    };
  };
}

/** Which workflow (if any) has a paused interrupt for this chat — i.e. the next inbound is a resume. */
export function createPausedWorkflowCheck(
  graphs: Record<Workflow, RunnableGraph>,
): (chatId: string) => Promise<Workflow | null> {
  return async function pausedWorkflow(chatId) {
    for (const wf of [
      "invoice",
      "payment",
      "expense",
      "report",
      "schedule",
    ] as Workflow[]) {
      const snapshot = await graphs[wf].getState({
        configurable: { thread_id: threadKey(wf, chatId) },
      });
      const tasks =
        (snapshot as { tasks?: Array<{ interrupts?: unknown[] }> }).tasks ?? [];
      const paused =
        tasks.some((t) => (t.interrupts?.length ?? 0) > 0) ||
        ((snapshot as { next?: unknown[] }).next?.length ?? 0) > 0;
      if (paused) return wf;
    }
    return null;
  };
}
