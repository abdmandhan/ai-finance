import type { ILogger } from "@/commons/logger";
import { AIMessage } from "@langchain/core/messages";
import { END } from "@langchain/langgraph";

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallResult {
  args: Record<string, unknown>;
  result: unknown;
}

export interface ExecuteToolCallsParams {
  pendingTools: ToolCallRequest[];
  toolMap: Record<
    string,
    { invoke(args: Record<string, unknown>): Promise<unknown> }
  >;
  logger: ILogger;
}

export interface BuildMaxStepsPayloadParams {
  stepCount: number;
  maxSteps: number;
  buildOutput: (msg: string) => Record<string, unknown>;
}

export const graphUtils = {
  routeByNextNode(state: { _nextNode?: string }): string {
    return state._nextNode ?? END;
  },

  /** Build identity path map for addConditionalEdges: [key]: key for each arg */
  buildPathMap<N extends string>(...nodes: N[]): Record<N, N> {
    return Object.fromEntries(nodes.map((n) => [n, n])) as Record<N, N>;
  },

  /**
   * Returns a terminal state payload when the step budget is exhausted,
   * null otherwise. Callers must add `stepCount: 1` on every normal return
   * so the budget actually counts.
   */
  buildMaxStepsPayload({
    stepCount,
    maxSteps,
    buildOutput,
  }: BuildMaxStepsPayloadParams): Record<string, unknown> | null {
    if (stepCount < maxSteps) return null;
    const msg = "Maximum processing steps reached";
    return {
      ...buildOutput(msg),
      stepCount: 1,
      messages: [new AIMessage(msg)],
      _nextNode: END,
    };
  },

  /**
   * Run pending tool calls in parallel; a failing tool becomes an error-string
   * result keyed `name:idx` instead of failing the whole batch.
   */
  async executeToolCalls({
    pendingTools,
    toolMap,
    logger,
  }: ExecuteToolCallsParams): Promise<Record<string, ToolCallResult>> {
    const settled = await Promise.allSettled(
      pendingTools.map(async (toolCall, idx) => {
        const tool = toolMap[toolCall.name];
        if (!tool) {
          logger.error({ toolName: toolCall.name }, "Tool not found");
          throw new Error(`tool "${toolCall.name}" not found in registry`);
        }
        const toolResult = await tool.invoke(toolCall.args);
        return [
          `${toolCall.name}:${idx}`,
          {
            args: toolCall.args,
            result: toolResult,
          } satisfies ToolCallResult,
        ] as const;
      }),
    );

    const results: Record<string, ToolCallResult> = {};
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const toolCall = pendingTools[i];
      if (outcome.status === "fulfilled") {
        const [key, value] = outcome.value;
        results[key] = value;
      } else {
        results[`${toolCall.name}:${i}`] = {
          args: toolCall.args,
          result:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
        };
        logger.error(
          { toolName: toolCall.name, err: outcome.reason },
          "Tool execution failed",
        );
      }
    }
    return results;
  },
};
