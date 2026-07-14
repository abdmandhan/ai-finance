import type { IKafkaService, IProcessLogService } from "@/services";
import { AIMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createAssistantHandler } from "./assistant.handler";
import { createCorrelationStore } from "./shared";

function inbound(text: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestId: "req-1",
    chatId: "chat-1",
    createdBy: "user-1",
    role: "human",
    content: [{ type: "text", text }],
    tenantId: "tenant-1",
    messageId: "msg-1",
    provider: "telegram",
    ...over,
  });
}

function setup(
  opts: {
    paused?: "schedule" | "invoice" | null;
    enablement?: { scheduling: boolean; invoicing: boolean; expense: boolean };
    graphState?: unknown;
    runOutcome?: unknown;
    publishPolicy?: "always_publish" | "workflow_only";
    processLog?: IProcessLogService;
  } = {},
) {
  const publishOutbound = vi.fn(async (_msg: any) => {});
  const kafka = {
    publishOutbound,
    publishEvent: vi.fn(async () => {}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    consume: vi.fn(),
  } as unknown as IKafkaService;
  const runWorkflow = vi.fn(async (..._args: any[]) => opts.runOutcome) as any;
  const assistantGraph = {
    invoke: vi.fn(
      async (..._args: any[]) =>
        opts.graphState ?? { messages: [new AIMessage("Hi!")], outcome: null },
    ),
    getState: vi.fn(),
  };
  const handler = createAssistantHandler({
    kafka,
    logger: pino({ level: "silent" }),
    audit: { runStarted: vi.fn(), toolCalled: vi.fn(), runFinished: vi.fn() },
    resolveEnablement: vi.fn(async () =>
      opts.enablement ?? { scheduling: true, invoicing: true, expense: false },
    ),
    runWorkflow,
    pausedWorkflow: vi.fn(async () => opts.paused ?? null),
    assistantGraph,
    correlations: createCorrelationStore(),
    publishPolicy: opts.publishPolicy,
    processLog: opts.processLog,
  });
  return { handler, publishOutbound, runWorkflow, assistantGraph };
}

function processLog() {
  return {
    runWithContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) =>
      fn(),
    ),
    log: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(),
    cleanupExpired: vi.fn(),
    startRetention: vi.fn(),
  } as unknown as IProcessLogService & {
    runWithContext: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
}

describe("assistant handler", () => {
  it("answers a fresh general message through the assistant — never silent", async () => {
    const { handler, publishOutbound, runWorkflow, assistantGraph } = setup({
      graphState: {
        messages: [new AIMessage("Accrual accounting records income when earned.")],
        outcome: null,
      },
    });

    await handler(inbound("What is accrual accounting?"));

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(assistantGraph.invoke).toHaveBeenCalledOnce();
    const [, config] = assistantGraph.invoke.mock.calls[0];
    expect(config.configurable.thread_id).toBe("assistant:chat-1");

    expect(publishOutbound).toHaveBeenCalledOnce();
    const out = publishOutbound.mock.calls[0][0];
    expect(out.requestId).toBe("req-1");
    expect(out.tenantId).toBe("tenant-1");
    expect(out.output.intent).toBe("ok");
    expect(out.output.answer).toContain("Accrual accounting");
  });

  it("records handler process log events for a fresh inbound turn", async () => {
    const log = processLog();
    const { handler } = setup({
      processLog: log,
      graphState: {
        messages: [new AIMessage("Accrual accounting records income when earned.")],
        outcome: null,
      },
    });

    await handler(inbound("What is accrual accounting?"));

    expect(log.runWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "req-1",
        chatId: "chat-1",
        tenantId: "tenant-1",
      }),
      expect.any(Function),
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "prompt.received" }),
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "assistant.invoke" }),
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "outbound.prepared" }),
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "turn.finished" }),
    );
  });

  it("suppresses fresh pure conversation when publish policy is workflow_only", async () => {
    const { handler, publishOutbound, runWorkflow, assistantGraph } = setup({
      publishPolicy: "workflow_only",
      graphState: {
        messages: [new AIMessage("Accrual accounting records income when earned.")],
        outcome: null,
      },
    });

    await handler(inbound("What is accrual accounting?"));

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(assistantGraph.invoke).toHaveBeenCalledOnce();
    expect(publishOutbound).not.toHaveBeenCalled();
  });

  it("still publishes a fresh workflow result when publish policy is workflow_only", async () => {
    const { handler, publishOutbound } = setup({
      publishPolicy: "workflow_only",
      graphState: {
        messages: [new AIMessage("Done — invoice INV-1 is authorised.")],
        outcome: {
          kind: "result",
          workflow: "invoice",
          result: {
            status: "created",
            summary: "INV-1 authorised.",
            invoiceId: "inv-1",
            completedApproval: {
              name: "xero_authorise_invoice",
              provider: "xero",
              ref: "inv-1",
              label: "INV-1 authorised.",
            },
          },
        },
      },
    });

    await handler(inbound("authorise invoice"));

    expect(publishOutbound).toHaveBeenCalledOnce();
    const out = publishOutbound.mock.calls[0][0];
    expect(out.output.intent).toBe("call_tool");
    expect(out.output.approvalData?.[0]?.name).toBe("xero_authorise_invoice");
  });

  it("still publishes a fresh workflow clarification when publish policy is workflow_only", async () => {
    const { handler, publishOutbound } = setup({
      publishPolicy: "workflow_only",
      graphState: {
        messages: [new AIMessage("Which currency?")],
        outcome: {
          kind: "clarification",
          workflow: "invoice",
          question: "Which currency?",
        },
      },
    });

    await handler(inbound("make an invoice"));

    expect(publishOutbound).toHaveBeenCalledOnce();
    expect(publishOutbound.mock.calls[0][0].output.intent).toBe(
      "needs_clarification",
    );
  });

  it("still publishes a fresh workflow approval when publish policy is workflow_only", async () => {
    const { handler, publishOutbound } = setup({
      publishPolicy: "workflow_only",
      graphState: {
        messages: [new AIMessage("Approve this invoice?")],
        outcome: {
          kind: "approval",
          workflow: "invoice",
          message: "Approve this invoice?",
          approval: {
            name: "xero_authorise_invoice",
            provider: "xero",
            items: [{ ref: "inv-1", label: "INV-1" }],
          },
        },
      },
    });

    await handler(inbound("authorise invoice"));

    expect(publishOutbound).toHaveBeenCalledOnce();
    const out = publishOutbound.mock.calls[0][0];
    expect(out.output.intent).toBe("call_tool");
    expect(out.output.approvalData?.[0]?.items?.[0]?.status).toBe("pending");
  });

  it("forwards the expense enablement flag into the assistant graph", async () => {
    const { handler, assistantGraph } = setup({
      enablement: { scheduling: true, invoicing: false, expense: true },
      graphState: { messages: [new AIMessage("ok")], outcome: null },
    });

    await handler(inbound("record $20 parking from the business account"));

    const [input] = assistantGraph.invoke.mock.calls[0];
    expect(input.enablement).toEqual({
      scheduling: true,
      invoicing: false,
      expense: true,
    });
  });

  it("resumes a paused workflow first; a re-interrupt is relayed verbatim", async () => {
    const { handler, publishOutbound, runWorkflow, assistantGraph } = setup({
      paused: "invoice",
      publishPolicy: "workflow_only",
      runOutcome: {
        kind: "clarification",
        workflow: "invoice",
        question: "Which currency?",
      },
    });

    await handler(inbound("Acme, 2500"));

    expect(runWorkflow).toHaveBeenCalledOnce();
    const [wf, chatId, cmd] = runWorkflow.mock.calls[0] as unknown[];
    expect(wf).toBe("invoice");
    expect(chatId).toBe("chat-1");
    expect(cmd).toBeInstanceOf(Command);
    expect(assistantGraph.invoke).not.toHaveBeenCalled();

    const out = publishOutbound.mock.calls[0][0];
    expect(out.output.intent).toBe("needs_clarification");
    expect(out.output.answer).toBe("Which currency?");
    expect(out.output.agentKey).toBe("invoicing");
  });

  it("phrases a resumed workflow's final result through the assistant (report mode)", async () => {
    const { handler, publishOutbound, assistantGraph } = setup({
      paused: "invoice",
      runOutcome: {
        kind: "result",
        workflow: "invoice",
        result: {
          status: "created",
          summary: "INV-1 authorised.",
          invoiceId: "inv-1",
          completedApproval: {
            name: "xero_authorise_invoice",
            provider: "xero",
            ref: "inv-1",
            label: "INV-1 authorised.",
          },
        },
      },
      graphState: {
        messages: [new AIMessage("All done — invoice INV-1 is authorised.")],
        outcome: null,
      },
    });

    await handler(inbound("yes"));

    const [input] = assistantGraph.invoke.mock.calls[0];
    expect(input.workflowReport?.kind).toBe("result");

    const out = publishOutbound.mock.calls[0][0];
    expect(out.output.intent).toBe("call_tool");
    expect(out.output.answer).toContain("INV-1 is authorised");
    expect(out.output.approvalData?.[0]?.items?.[0]).toEqual({
      ref: "inv-1",
      label: "INV-1 authorised.",
      status: "completed",
    });
  });

  it("gates a paused workflow whose agent was disabled mid-conversation", async () => {
    const { handler, publishOutbound, runWorkflow } = setup({
      paused: "schedule",
      enablement: { scheduling: false, invoicing: true, expense: false },
    });

    await handler(inbound("tomorrow at 10"));

    expect(runWorkflow).not.toHaveBeenCalled();
    const out = publishOutbound.mock.calls[0][0];
    expect(out.output.intent).toBe("not_supported");
    expect(out.output.answer).toBe(
      "The Scheduling agent is currently disabled for your workspace.",
    );
    expect(out.output.agentKey).toBe("scheduling");
  });

  it("still chats when all workflow agents are disabled", async () => {
    const { handler, publishOutbound, assistantGraph } = setup({
      enablement: { scheduling: false, invoicing: false, expense: false },
      graphState: { messages: [new AIMessage("Happy to help!")], outcome: null },
    });

    await handler(inbound("hello"));

    expect(assistantGraph.invoke).toHaveBeenCalledOnce();
    expect(publishOutbound.mock.calls[0][0].output.intent).toBe("ok");
  });

  it("publishes an apology instead of dropping on internal errors", async () => {
    const { handler, publishOutbound, assistantGraph } = setup();
    assistantGraph.invoke.mockRejectedValueOnce(new Error("boom"));

    await handler(inbound("hi"));

    const out = publishOutbound.mock.calls[0][0];
    expect(out.output.intent).toBe("not_supported");
    expect(out.output.answer).toContain("Sorry, something went wrong");
  });
});
