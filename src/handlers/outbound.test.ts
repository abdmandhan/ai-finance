import type { AssistantWorkflowOutcome } from "@/schemas";
import { describe, expect, it } from "vitest";
import { defaultAnswerFor, outcomeToOutput } from "./outbound";

describe("outcomeToOutput", () => {
  it("maps pure conversation (no outcome) to ok", () => {
    expect(outcomeToOutput(null, "Hi!")).toEqual({ answer: "Hi!", intent: "ok" });
  });

  it("maps agent_disabled to not_supported with agentKey", () => {
    const out = outcomeToOutput(
      { kind: "agent_disabled", workflow: "invoice" },
      "disabled",
    );
    expect(out).toEqual({
      answer: "disabled",
      intent: "not_supported",
      agentKey: "invoicing",
    });
  });

  it("maps clarification to needs_clarification", () => {
    const out = outcomeToOutput(
      { kind: "clarification", workflow: "schedule", question: "When?" },
      "When?",
    );
    expect(out).toEqual({
      answer: "When?",
      intent: "needs_clarification",
      agentKey: "scheduling",
    });
  });

  it("maps approval to call_tool with pending approvalData", () => {
    const out = outcomeToOutput(
      {
        kind: "approval",
        workflow: "invoice",
        message: "Approve?",
        approval: {
          name: "xero_authorise_invoice",
          provider: "xero",
          items: [{ ref: "inv-1", label: "Acme" }],
        },
      },
      "Approve?",
    );
    expect(out.intent).toBe("call_tool");
    expect(out.agentKey).toBe("invoicing");
    expect(out.approvalData).toEqual([
      {
        name: "xero_authorise_invoice",
        provider: "xero",
        items: [{ ref: "inv-1", label: "Acme", status: "pending" }],
      },
    ]);
  });

  const result = (
    workflow: "schedule" | "invoice",
    over: Record<string, unknown>,
  ): AssistantWorkflowOutcome => ({
    kind: "result",
    workflow,
    result: { status: "failed", summary: "s", ...over },
  });

  it("maps created (schedule) to call_tool with completed approvalData", () => {
    const out = outcomeToOutput(
      result("schedule", { status: "created", eventId: "ev-1" }),
      "Booked",
    );
    expect(out.intent).toBe("call_tool");
    expect(out.approvalData).toEqual([
      {
        name: "create_calendar_event",
        provider: "calendar",
        items: [{ ref: "ev-1", label: "s", status: "completed" }],
      },
    ]);
  });

  it("maps created (invoice) to call_tool with xero approvalData", () => {
    const out = outcomeToOutput(
      result("invoice", { status: "created", invoiceId: "inv-9" }),
      "Authorised",
    );
    expect(out.approvalData?.[0]?.name).toBe("xero_authorise_invoice");
    expect(out.approvalData?.[0]?.provider).toBe("xero");
    expect(out.approvalData?.[0]?.items?.[0]?.ref).toBe("inv-9");
  });

  it("maps proposed to needs_clarification", () => {
    const out = outcomeToOutput(result("schedule", { status: "proposed" }), "a");
    expect(out.intent).toBe("needs_clarification");
    expect(out.approvalData).toBeUndefined();
  });

  it("maps answered to ok", () => {
    expect(outcomeToOutput(result("schedule", { status: "answered" }), "a").intent).toBe("ok");
  });

  it("maps failed/other to not_supported", () => {
    expect(outcomeToOutput(result("invoice", { status: "failed" }), "a").intent).toBe(
      "not_supported",
    );
    expect(outcomeToOutput(result("invoice", { status: "rejected" }), "a").intent).toBe(
      "not_supported",
    );
  });
});

describe("defaultAnswerFor", () => {
  it("uses the clarification question / approval message verbatim", () => {
    expect(
      defaultAnswerFor({ kind: "clarification", workflow: "schedule", question: "When?" }),
    ).toBe("When?");
    expect(
      defaultAnswerFor({
        kind: "approval",
        workflow: "invoice",
        message: "Approve?",
        approval: { name: "n", provider: "p", items: [] },
      }),
    ).toBe("Approve?");
  });

  it("matches the legacy disabled wording", () => {
    expect(defaultAnswerFor({ kind: "agent_disabled", workflow: "schedule" })).toBe(
      "The Scheduling agent is currently disabled for your workspace.",
    );
    expect(defaultAnswerFor({ kind: "agent_disabled", workflow: "invoice" })).toBe(
      "The Invoicing agent is currently disabled for your workspace.",
    );
  });

  it("appends open slots for proposed and htmlLink for created", () => {
    expect(
      defaultAnswerFor({
        kind: "result",
        workflow: "schedule",
        result: {
          status: "proposed",
          summary: "Busy then.",
          suggestedSlots: [{ start: "2026-07-15T10:00", end: "2026-07-15T10:30" }],
        },
      }),
    ).toBe("Busy then.\nSome open times:\n- 2026-07-15T10:00");
    expect(
      defaultAnswerFor({
        kind: "result",
        workflow: "schedule",
        result: { status: "created", summary: "Booked.", htmlLink: "https://cal/x" },
      }),
    ).toBe("Booked.\nhttps://cal/x");
  });
});
