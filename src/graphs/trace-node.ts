import type { IProcessLogService, Workflow } from "@/services";

type TraceWorkflow = Workflow | "assistant";

interface TraceableNode<State> {
  name: string;
  node: (state: State) => unknown | Promise<unknown>;
}

function outputSummary(output: unknown): unknown {
  const out = output as
    | {
        _nextNode?: unknown;
        result?: unknown;
        approved?: unknown;
        messages?: unknown[];
      }
    | null
    | undefined;
  if (!out || typeof out !== "object") return output;
  return {
    nextNode: out._nextNode,
    result: out.result,
    approved: out.approved,
    messages: Array.isArray(out.messages) ? out.messages.length : undefined,
  };
}

export function traceGraphNode<State>(
  deps: { processLog?: IProcessLogService },
  workflow: TraceWorkflow,
  entry: TraceableNode<State>,
): TraceableNode<State> {
  return {
    name: entry.name,
    node: async (state: State) => {
      const started = Date.now();
      deps.processLog?.log({
        event: "node.start",
        workflow,
        node: entry.name,
        payload: { state },
      });
      try {
        const output = await entry.node(state);
        deps.processLog?.log({
          event: "node.end",
          workflow,
          node: entry.name,
          status: "ok",
          durationMs: Date.now() - started,
          payload: { output: outputSummary(output) },
        });
        return output;
      } catch (error) {
        deps.processLog?.log({
          event: "node.error",
          workflow,
          node: entry.name,
          status: "error",
          durationMs: Date.now() - started,
          error,
        });
        throw error;
      }
    },
  };
}
