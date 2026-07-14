import type { IProcessLogService } from "@/services";
import { describe, expect, it, vi } from "vitest";
import { traceGraphNode } from "./trace-node";

function processLog() {
  return {
    log: vi.fn(),
  } as unknown as IProcessLogService & { log: ReturnType<typeof vi.fn> };
}

describe("traceGraphNode", () => {
  it("logs node start and end without changing the output", async () => {
    const log = processLog();
    const node = traceGraphNode({ processLog: log }, "report", {
      name: "fetch_report_data",
      node: async () => ({ result: { status: "answered", summary: "ok" } }),
    });

    const out = await node.node({ threadId: "chat-1" });

    expect(out).toEqual({ result: { status: "answered", summary: "ok" } });
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "node.start",
        workflow: "report",
        node: "fetch_report_data",
      }),
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "node.end",
        workflow: "report",
        node: "fetch_report_data",
        status: "ok",
      }),
    );
  });

  it("logs node errors and rethrows", async () => {
    const log = processLog();
    const error = new Error("boom");
    const node = traceGraphNode({ processLog: log }, "invoice", {
      name: "create_draft_invoice",
      node: async () => {
        throw error;
      },
    });

    await expect(node.node({ threadId: "chat-1" })).rejects.toThrow("boom");

    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "node.error",
        workflow: "invoice",
        node: "create_draft_invoice",
        status: "error",
        error,
      }),
    );
  });
});
