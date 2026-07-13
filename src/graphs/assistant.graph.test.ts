import type { AssistantDeps } from "@/nodes";
import type { AssistantWorkflowOutcome } from "@/schemas";
import type { ILlmService } from "@/services";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { buildAssistantGraph } from "./assistant.graph";

function toolCallMessage(name: string, request: string): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args: { request }, id: "call-1", type: "tool_call" }],
  });
}

function buildGraph(
  opts: {
    replies?: AIMessage[];
    outcomes?: AssistantWorkflowOutcome[];
  } = {},
) {
  const logger = pino({ level: "silent" });
  const chat = vi.fn();
  for (const r of opts.replies ?? [new AIMessage("Hello!")]) {
    chat.mockResolvedValueOnce(r);
  }
  const llmService: ILlmService = { invoke: vi.fn(), extract: vi.fn(), chat };
  const runWorkflow = vi.fn();
  for (const o of opts.outcomes ?? []) runWorkflow.mockResolvedValueOnce(o);
  const deps: AssistantDeps = {
    llmService,
    runWorkflow,
    audit: { runStarted: vi.fn(), toolCalled: vi.fn(), runFinished: vi.fn() },
    defaultTimezone: "UTC",
    maxHistoryMessages: 30,
    logger,
  };
  return {
    graph: buildAssistantGraph(deps, new MemorySaver()),
    chat,
    runWorkflow,
  };
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    messages: [{ role: "user", content: "hi" }],
    chatId: "chat-1",
    tenantId: "tenant-1",
    userId: "user-1",
    attachments: [],
    enablement: { scheduling: true, invoicing: true, expense: true },
    workflowReport: null,
    outcome: null,
    ...over,
  };
}

const config = (thread: string) => ({ configurable: { thread_id: thread } });

describe("assistant graph", () => {
  it("answers a general question directly — no tool call", async () => {
    const { graph, runWorkflow } = buildGraph({
      replies: [
        new AIMessage(
          "Accrual accounting records income and expenses when earned or incurred.",
        ),
      ],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "What is accrual accounting?" }],
      }),
      config("t-general"),
    );

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(result.outcome ?? null).toBeNull();
    expect(result.messages.at(-1).content).toContain("Accrual accounting");
  });

  it("routes a schedule request through the tool and captures the result", async () => {
    const outcome: AssistantWorkflowOutcome = {
      kind: "result",
      workflow: "schedule",
      result: {
        status: "created",
        summary: "Meeting with Sarah booked.",
        eventId: "ev-1",
      },
    };
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("schedule_meeting", "Meet Sarah tomorrow 10am"),
        new AIMessage("Done — I booked the meeting with Sarah."),
      ],
      outcomes: [outcome],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [
          { role: "user", content: "Schedule with Sarah tomorrow 10am" },
        ],
      }),
      config("t-schedule"),
    );

    expect(runWorkflow).toHaveBeenCalledWith("schedule", "chat-1", {
      threadId: "chat-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userMessage: "Meet Sarah tomorrow 10am",
    });
    expect(result.outcome).toEqual(outcome);
    const toolMsg = result.messages.find((m: any) => m instanceof ToolMessage);
    expect(JSON.parse(toolMsg.content).status).toBe("created");
    expect(result.messages.at(-1).content).toContain("booked");
  });

  it("withholds tools on the relay turn after a workflow pauses", async () => {
    const { graph, chat } = buildGraph({
      replies: [
        toolCallMessage("schedule_meeting", "Meet Sarah"),
        new AIMessage("When would you like to meet Sarah?"),
      ],
      outcomes: [
        {
          kind: "clarification",
          workflow: "schedule",
          question: "When would you like to meet?",
        },
      ],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "Schedule with Sarah" }],
      }),
      config("t-clarify"),
    );

    expect(result.outcome.kind).toBe("clarification");
    // First model call offers tools; the relay call must not.
    expect(chat.mock.calls[0][1]?.tools?.length).toBeGreaterThan(0);
    expect(chat.mock.calls[1][1]).toBeUndefined();
  });

  it("captures an approval interrupt with its structured approval data", async () => {
    const approval = {
      name: "xero_authorise_invoice",
      provider: "xero",
      items: [{ ref: "inv-1", label: "Acme $2,500" }],
    };
    const { graph } = buildGraph({
      replies: [
        toolCallMessage("create_invoice", "Invoice Acme $2,500"),
        new AIMessage("I drafted the invoice — approve to authorise it."),
      ],
      outcomes: [
        {
          kind: "approval",
          workflow: "invoice",
          message: "Authorise draft invoice for Acme?",
          approval,
        },
      ],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "Invoice Acme $2,500" }],
      }),
      config("t-approval"),
    );

    expect(result.outcome.kind).toBe("approval");
    expect(result.outcome.approval).toEqual(approval);
  });

  it("gates a disabled agent without invoking the workflow", async () => {
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("create_invoice", "Invoice Acme"),
        new AIMessage("Invoicing is currently disabled for your workspace."),
      ],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "Invoice Acme" }],
        enablement: { scheduling: true, invoicing: false, expense: true },
      }),
      config("t-disabled"),
    );

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(result.outcome).toEqual({
      kind: "agent_disabled",
      workflow: "invoice",
    });
    const toolMsg = result.messages.find((m: any) => m instanceof ToolMessage);
    expect(JSON.parse(toolMsg.content).status).toBe("agent_disabled");
  });

  it("keeps conversation memory across turns on one thread", async () => {
    const { graph, chat } = buildGraph({
      replies: [
        new AIMessage("It records income when earned."),
        new AIMessage("Yes."),
      ],
    });
    const cfg = config("t-memory");

    await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "What is accrual accounting?" }],
      }),
      cfg,
    );
    await graph.invoke(
      baseInput({ messages: [{ role: "user", content: "Is it required?" }] }),
      cfg,
    );

    // Second call sees turn 1 (human + ai) plus turn 2's human message, after the system prompt.
    const secondCallMessages = chat.mock.calls[1][0];
    const texts = secondCallMessages.map((m: any) => String(m.content));
    expect(
      texts.some((t: string) => t.includes("What is accrual accounting?")),
    ).toBe(true);
    expect(
      texts.some((t: string) => t.includes("It records income when earned.")),
    ).toBe(true);
    expect(texts.at(-1)).toContain("Is it required?");
  });

  it("ends a runaway model↔tools loop at the step cap instead of spinning forever", async () => {
    const logger = pino({ level: "silent" });
    // Model that ALWAYS asks for another tool call; workflow always returns a result.
    const chat = vi.fn(async () =>
      toolCallMessage("schedule_meeting", "again"),
    );
    const runWorkflow = vi.fn(async () => ({
      kind: "result" as const,
      workflow: "schedule" as const,
      result: { status: "created", summary: "ok" },
    }));
    const deps: AssistantDeps = {
      llmService: { invoke: vi.fn(), extract: vi.fn(), chat },
      runWorkflow,
      audit: { runStarted: vi.fn(), toolCalled: vi.fn(), runFinished: vi.fn() },
      defaultTimezone: "UTC",
      maxHistoryMessages: 30,
      logger,
    };
    const graph = buildAssistantGraph(deps, new MemorySaver());

    const result: any = await graph.invoke(
      baseInput({ messages: [{ role: "user", content: "loop me" }] }),
      { ...config("t-max-steps"), recursionLimit: 100 },
    );

    expect(String(result.messages.at(-1).content)).toContain(
      "Maximum processing steps reached",
    );
    // The cap (25 model steps) bounds the loop well under the recursion limit.
    expect(chat.mock.calls.length).toBeLessThanOrEqual(25);
  });

  it("turns a crashed workflow into an error tool result instead of killing the run", async () => {
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("schedule_meeting", "Meet Sarah"),
        new AIMessage("Sorry, scheduling failed — try again shortly."),
      ],
    });
    runWorkflow.mockRejectedValue(new Error("calendar API down"));

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "Schedule with Sarah" }],
      }),
      config("t-wf-error"),
    );

    const toolMsg = result.messages.find((m: any) => m instanceof ToolMessage);
    expect(JSON.parse(toolMsg.content)).toEqual({
      status: "error",
      message: "calendar API down",
    });
    expect(String(result.messages.at(-1).content)).toContain("failed");
  });

  it("caps checkpointed conversation memory at 25 messages", async () => {
    const replies = Array.from(
      { length: 20 },
      (_, i) => new AIMessage(`r${i}`),
    );
    const { graph } = buildGraph({ replies });
    const cfg = config("t-msg-cap");

    for (let i = 0; i < 20; i++) {
      await graph.invoke(
        baseInput({ messages: [{ role: "user", content: `turn ${i}` }] }),
        cfg,
      );
    }

    const state: any = await (graph as any).getState(cfg);
    expect(state.values.messages.length).toBeLessThanOrEqual(25);
    // newest survive the window
    expect(String(state.values.messages.at(-1).content)).toBe("r19");
  });

  it("routes a payment request to the payment workflow", async () => {
    const outcome: AssistantWorkflowOutcome = {
      kind: "approval",
      workflow: "payment",
      message: "Record 500 against INV-100?",
      approval: {
        name: "xero_apply_payment",
        provider: "xero",
        items: [{ ref: "i-100" }],
      },
    };
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("record_payment", "Mark INV-100 as paid from BCA"),
        new AIMessage("Please approve the payment."),
      ],
      outcomes: [outcome],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "Mark INV-100 as paid from BCA" }],
      }),
      config("t-payment"),
    );

    expect(runWorkflow).toHaveBeenCalledWith("payment", "chat-1", {
      threadId: "chat-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userMessage: "Mark INV-100 as paid from BCA",
    });
    expect(result.outcome).toEqual(outcome);
  });

  it("routes an expense request to the expense workflow WITH attachments", async () => {
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("record_expense", "record this receipt"),
        new AIMessage("Please approve."),
      ],
      outcomes: [
        {
          kind: "approval",
          workflow: "expense",
          message: "Record spend of 20?",
          approval: {
            name: "xero_spend_money",
            provider: "xero",
            items: [{ ref: "090" }],
          },
        },
      ],
    });
    const attachments = [
      { url: "http://minio/r.jpg", mimeType: "image/jpeg", fileName: "r.jpg" },
    ];

    await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "record this receipt" }],
        attachments,
      }),
      config("t-expense"),
    );

    expect(runWorkflow).toHaveBeenCalledWith("expense", "chat-1", {
      threadId: "chat-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userMessage: "record this receipt",
      attachments,
    });
  });

  it("XERO-AI-007: routes a read-only question to the report workflow (no attachments, no approval)", async () => {
    const outcome: AssistantWorkflowOutcome = {
      kind: "result",
      workflow: "report",
      result: {
        status: "answered",
        summary: "Expenses for July 2026: SGD 3,000 (accrual basis).",
      },
    };
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("financial_report", "How much did we spend this month?"),
        new AIMessage("You spent SGD 3,000 this month."),
      ],
      outcomes: [outcome],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "How much did we spend this month?" }],
        attachments: [
          { url: "http://x/y.jpg", mimeType: "image/jpeg", fileName: "y.jpg" },
        ],
      }),
      config("t-report-tool"),
    );

    // Report workflow gets NO attachments — it is read-only.
    expect(runWorkflow).toHaveBeenCalledWith("report", "chat-1", {
      threadId: "chat-1",
      tenantId: "tenant-1",
      userId: "user-1",
      userMessage: "How much did we spend this month?",
    });
    expect(result.outcome.kind).toBe("result");
  });

  it("gates the expense workflow on its own enablement flag", async () => {
    const { graph, runWorkflow } = buildGraph({
      replies: [
        toolCallMessage("record_expense", "record $20 parking"),
        new AIMessage("The expense agent is disabled."),
      ],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "record $20 parking" }],
        enablement: { scheduling: true, invoicing: true, expense: false },
      }),
      config("t-expense-gated"),
    );

    expect(runWorkflow).not.toHaveBeenCalled();
    expect(result.outcome).toEqual({
      kind: "agent_disabled",
      workflow: "expense",
    });
  });

  it("injects the workflow report on a resume turn and withholds tools", async () => {
    const report: AssistantWorkflowOutcome = {
      kind: "result",
      workflow: "invoice",
      result: {
        status: "created",
        summary: "Invoice INV-1 authorised.",
        invoiceId: "inv-1",
      },
    };
    const { graph, chat } = buildGraph({
      replies: [new AIMessage("Your invoice INV-1 is authorised.")],
    });

    const result: any = await graph.invoke(
      baseInput({
        messages: [{ role: "user", content: "yes" }],
        workflowReport: report,
      }),
      config("t-report"),
    );

    const systemTexts = chat.mock.calls[0][0]
      .filter((m: any) => m.getType?.() === "system")
      .map((m: any) => String(m.content));
    expect(
      systemTexts.some((t: string) => t.includes("Invoice INV-1 authorised.")),
    ).toBe(true);
    expect(chat.mock.calls[0][1]).toBeUndefined(); // no tools in report mode
    expect(result.messages.at(-1).content).toContain("authorised");
  });
});
