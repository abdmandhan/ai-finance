import { END } from "@langchain/langgraph";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { graphUtils } from "./graph-utils";

const logger = pino({ level: "silent" });

describe("graphUtils.executeToolCalls", () => {
  it("runs tools in parallel and keys results name:idx", async () => {
    const toolMap = {
      alpha: { invoke: vi.fn(async (args: unknown) => ({ ok: true, args })) },
      beta: { invoke: vi.fn(async () => "beta-result") },
    };

    const results = await graphUtils.executeToolCalls({
      pendingTools: [
        { name: "alpha", args: { x: 1 } },
        { name: "beta", args: {} },
        { name: "alpha", args: { x: 2 } },
      ],
      toolMap,
      logger,
    });

    expect(Object.keys(results).sort()).toEqual([
      "alpha:0",
      "alpha:2",
      "beta:1",
    ]);
    expect(results["beta:1"].result).toBe("beta-result");
    expect(toolMap.alpha.invoke).toHaveBeenCalledTimes(2);
  });

  it("captures a failing tool as an error-string result without failing the batch", async () => {
    const toolMap = {
      good: { invoke: async () => "fine" },
      bad: {
        invoke: async () => {
          throw new Error("boom");
        },
      },
    };

    const results = await graphUtils.executeToolCalls({
      pendingTools: [
        { name: "good", args: {} },
        { name: "bad", args: {} },
      ],
      toolMap,
      logger,
    });

    expect(results["good:0"].result).toBe("fine");
    expect(results["bad:1"].result).toBe("boom");
  });

  it("captures an unknown tool as an error result", async () => {
    const results = await graphUtils.executeToolCalls({
      pendingTools: [{ name: "ghost", args: {} }],
      toolMap: {},
      logger,
    });

    expect(String(results["ghost:0"].result)).toContain("not found");
  });
});

describe("graphUtils.buildMaxStepsPayload", () => {
  it("returns null while under budget", () => {
    expect(
      graphUtils.buildMaxStepsPayload({
        stepCount: 5,
        maxSteps: 25,
        buildOutput: () => ({}),
      }),
    ).toBeNull();
  });

  it("returns a terminal payload at the cap", () => {
    const payload = graphUtils.buildMaxStepsPayload({
      stepCount: 25,
      maxSteps: 25,
      buildOutput: (msg) => ({ note: msg }),
    });
    expect(payload).not.toBeNull();
    expect(payload!._nextNode).toBe(END);
    expect(payload!.note).toBe("Maximum processing steps reached");
  });
});

describe("graphUtils.buildPathMap / routeByNextNode", () => {
  it("builds identity map and routes by _nextNode with END fallback", () => {
    expect(graphUtils.buildPathMap("a", "b")).toEqual({ a: "a", b: "b" });
    expect(graphUtils.routeByNextNode({ _nextNode: "a" })).toBe("a");
    expect(graphUtils.routeByNextNode({})).toBe(END);
  });
});
