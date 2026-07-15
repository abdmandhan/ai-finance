import type { AssistantWorkflowOutcome } from "@/schemas";
import { describe, expect, it } from "vitest";
import { defaultAnswerFor, outcomeToOutput } from "./outbound";

describe("outcomeToOutput", () => {
  it("maps pure conversation (no outcome) to ok", () => {
    expect(outcomeToOutput(null, "Hi!")).toEqual({
      answer: "Hi!",
      intent: "ok",
    });
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
    workflow: AssistantWorkflowOutcome["workflow"],
    over: Record<string, unknown>,
  ): AssistantWorkflowOutcome => ({
    kind: "result",
    workflow,
    result: { status: "failed", summary: "s", ...over },
  });

  it("does not infer completed approvalData from ids alone", () => {
    const out = outcomeToOutput(
      result("schedule", { status: "created", eventId: "ev-1" }),
      "Booked",
    );
    expect(out.intent).toBe("not_supported");
    expect(out.approvalData).toBeUndefined();
  });

  it.each([
    ["schedule", "created", "create_calendar_event", "calendar", "ev-1"],
    ["invoice", "created", "xero_authorise_invoice", "xero", "inv-9"],
    ["payment", "created", "xero_apply_payment", "xero", "pay-1"],
    ["payment", "created", "xero_create_credit_note", "xero", "cn-1"],
    ["payment", "reversed", "xero_reverse_payment", "xero", "pay-2"],
    ["payment", "voided", "xero_void_invoice", "xero", "inv-void"],
    ["expense", "created", "xero_spend_money", "xero", "bt-spend"],
    ["expense", "created", "xero_receive_money", "xero", "bt-receive"],
    ["expense", "created", "xero_bank_transfer", "xero", "tr-1"],
  ] as const)(
    "maps completed %s/%s to %s approvalData",
    (workflow, status, name, provider, ref) => {
      const out = outcomeToOutput(
        result(workflow, {
          status,
          completedApproval: { name, provider, ref, label: "Done." },
        }),
        "Done",
      );

      expect(out.intent).toBe("call_tool");
      expect(out.approvalData).toEqual([
        {
          name,
          provider,
          items: [{ ref, label: "Done.", status: "completed" }],
        },
      ]);
    },
  );

  it("falls back to result summary when completed approval has no label", () => {
    const out = outcomeToOutput(
      result("payment", {
        status: "created",
        summary: "Payment recorded.",
        completedApproval: {
          name: "xero_apply_payment",
          provider: "xero",
          ref: "pay-1",
        },
      }),
      "Payment recorded.",
    );

    expect(out.intent).toBe("call_tool");
    expect(out.approvalData).toEqual([
      {
        name: "xero_apply_payment",
        provider: "xero",
        items: [
          { ref: "pay-1", label: "Payment recorded.", status: "completed" },
        ],
      },
    ]);
  });

  it("uses completed approval items when an amendment produces multiple Xero refs", () => {
    const out = outcomeToOutput(
      result("invoice", {
        status: "corrected",
        summary: "Corrected.",
        completedApproval: {
          name: "xero_amend_invoice",
          provider: "xero",
          ref: "replacement-1",
          items: [
            { ref: "cn-1", label: "credit note", detail: "credits original" },
            { ref: "replacement-1", label: "replacement invoice" },
          ],
        },
      }),
      "Corrected.",
    );

    expect(out.intent).toBe("call_tool");
    expect(out.approvalData).toEqual([
      {
        name: "xero_amend_invoice",
        provider: "xero",
        items: [
          {
            ref: "cn-1",
            label: "credit note",
            detail: "credits original",
            status: "completed",
          },
          {
            ref: "replacement-1",
            label: "replacement invoice",
            status: "completed",
          },
        ],
      },
    ]);
  });

  it("maps proposed to needs_clarification", () => {
    const out = outcomeToOutput(
      result("schedule", { status: "proposed" }),
      "a",
    );
    expect(out.intent).toBe("needs_clarification");
    expect(out.approvalData).toBeUndefined();
  });

  it("maps answered to ok", () => {
    expect(
      outcomeToOutput(result("schedule", { status: "answered" }), "a").intent,
    ).toBe("ok");
  });

  it("maps failed/other to not_supported", () => {
    expect(
      outcomeToOutput(result("invoice", { status: "failed" }), "a").intent,
    ).toBe("not_supported");
    expect(
      outcomeToOutput(result("invoice", { status: "rejected" }), "a").intent,
    ).toBe("not_supported");
  });
});

describe("defaultAnswerFor", () => {
  it("uses the clarification question / approval message verbatim", () => {
    expect(
      defaultAnswerFor({
        kind: "clarification",
        workflow: "schedule",
        question: "When?",
      }),
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
    expect(
      [
        ["schedule", "Scheduling"],
        ["invoice", "Invoicing"],
        ["payment", "Payments"],
        ["expense", "Expense"],
        ["report", "Reporting"],
      ].map(
        ([workflow, label]) =>
          defaultAnswerFor({
            kind: "agent_disabled",
            workflow: workflow as AssistantWorkflowOutcome["workflow"],
          }) === `The ${label} agent is currently disabled for your workspace.`,
      ),
    ).toEqual([true, true, true, true, true]);
  });

  it("appends open slots for proposed and htmlLink for created", () => {
    expect(
      defaultAnswerFor({
        kind: "result",
        workflow: "schedule",
        result: {
          status: "proposed",
          summary: "Busy then.",
          suggestedSlots: [
            { start: "2026-07-15T10:00", end: "2026-07-15T10:30" },
          ],
        },
      }),
    ).toBe("Busy then.\nSome open times:\n- 2026-07-15T10:00");
    expect(
      defaultAnswerFor({
        kind: "result",
        workflow: "schedule",
        result: {
          status: "created",
          summary: "Booked.",
          htmlLink: "https://cal/x",
        },
      }),
    ).toBe("Booked.\nhttps://cal/x");
  });
});
