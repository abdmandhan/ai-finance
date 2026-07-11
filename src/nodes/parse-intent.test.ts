import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { ScheduleIntent } from "@/schemas";
import type { ILlmService } from "@/services";
import { makeParseIntentNode } from "./parse-intent";
import { NODES, type ScheduleDeps } from "./shared";

function buildDeps(over: Partial<ScheduleIntent>): ScheduleDeps {
  const intent: ScheduleIntent = {
    intent: "schedule_meeting",
    attendee: null,
    attendeeEmail: null,
    durationMinutes: null,
    timezone: null,
    timeframe: null,
    requestedStartIso: null,
    location: null,
    clarificationQuestion: null,
    rangeStartIso: null,
    rangeEndIso: null,
    ...over,
  };
  return {
    llmService: {
      invoke: vi.fn(),
      extract: vi.fn().mockResolvedValue(intent),
      chat: vi.fn(),
    } as ILlmService,
    calendarTool: {} as ScheduleDeps["calendarTool"],
    contactsTool: {} as ScheduleDeps["contactsTool"],
    mapsTool: {} as ScheduleDeps["mapsTool"],
    resolveAuth: (async () => ({}) as never) as ScheduleDeps["resolveAuth"],
    defaultTimezone: "UTC",
    schedulingPrefs: {
      bufferMinutes: 15,
      workingHoursStart: 9,
      workingHoursEnd: 18,
    },
    logger: pino({ level: "silent" }),
  };
}

const baseState = {
  threadId: "t1",
  userMessage: "hi",
  clarifyAttempts: 0,
} as any;

describe("parse-intent node", () => {
  it("routes to resolve_contact when attendee and timeframe are present", async () => {
    const node = makeParseIntentNode(
      buildDeps({ attendee: "Sarah", timeframe: "next week" }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.resolveContact);
    expect(out.durationMinutes).toBe(30); // default applied
    expect(out.attendee).toBe("Sarah");
  });

  it("extracts attendeeEmail when explicitly present", async () => {
    const node = makeParseIntentNode(
      buildDeps({
        attendee: "Sarah",
        timeframe: "next week",
        attendeeEmail: "sarah@x.com",
      }),
    );
    const out = await node.node(baseState);
    expect(out.attendeeEmail).toBe("sarah@x.com");
    expect(out._nextNode).toBe(NODES.resolveContact);
  });

  it('treats a concrete requestedStartIso as the "when" (no NL timeframe needed)', async () => {
    const node = makeParseIntentNode(
      buildDeps({
        attendee: "Sarah",
        timeframe: null,
        requestedStartIso: "2026-07-12T10:00:00.000Z",
      }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.resolveContact);
    expect(out.requestedStartIso).toBe("2026-07-12T10:00:00.000Z");
  });

  it("routes to clarification when required info is missing", async () => {
    const node = makeParseIntentNode(
      buildDeps({ clarificationQuestion: "Who should I meet with and when?" }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.askClarification);
  });

  it("routes a lookup question straight to lookup_schedule with its window", async () => {
    const node = makeParseIntentNode(
      buildDeps({
        intent: "lookup_schedule",
        rangeStartIso: "2026-07-12T00:00:00.000Z",
        rangeEndIso: "2026-07-13T00:00:00.000Z",
      }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.lookupSchedule);
    expect(out.rangeStartIso).toBe("2026-07-12T00:00:00.000Z");
    expect(out.rangeEndIso).toBe("2026-07-13T00:00:00.000Z");
  });

  it("fails cleanly for unsupported requests", async () => {
    const node = makeParseIntentNode(buildDeps({ intent: "unsupported" }));
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.finalize);
    expect(out.result?.status).toBe("failed");
  });

  it("gives up after max clarify attempts instead of looping", async () => {
    const node = makeParseIntentNode(
      buildDeps({ clarificationQuestion: "Who and when?" }),
    );
    const out = await node.node({ ...baseState, clarifyAttempts: 2 });
    expect(out._nextNode).toBe(NODES.finalize);
    expect(out.result?.status).toBe("failed");
  });
});
