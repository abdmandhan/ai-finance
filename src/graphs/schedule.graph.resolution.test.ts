/**
 * Stateful resolution loop (test cases 4, 5, 14, 15, 16, 30): conflict /
 * travel / preference / no-slot proposals pause the graph; the principal's
 * chosen resolution — and only that — is executed after they reply.
 */
import { describe, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import type { Resolution } from "@/schemas";
import { buildGraph, intent } from "./schedule.test-utils";

function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    action: "unclear",
    optionIndex: null,
    newDurationMinutes: null,
    newStartIso: null,
    targetEventSummary: null,
    ...over,
  };
}

const knownSarah = [{ name: "Sarah", email: "sarah@example.com" }];

describe("resolution loop — principal picks the outcome (cases 15, 16)", () => {
  it('books the requested time on "accept it, I\'ll arrive late"', async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
          location: "Acme HQ",
        }),
        resolution({ action: "accept_anyway" }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Client visit",
          start: "2026-07-13T09:00:00.000Z",
          end: "2026-07-13T09:50:00.000Z",
          location: "Far side of town",
        },
      ],
      travelMinutes: 45, // 45 > 10 min gap → travel proposal
    });
    const config = { configurable: { thread_id: "t-accept" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-accept",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10 at Acme HQ",
      },
      config,
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("proposal");
    expect(calendarTool.created).toHaveLength(0); // nothing booked before the reply

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "accept it, I'll arrive late" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    expect(calendarTool.created[0]?.start).toBe("2026-07-13T10:00:00.000Z");
  });

  it('shortens the meeting on "shorten to 30 min" and revalidates', async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T15:00:00.000Z",
          timeframe: null,
          durationMinutes: 60, // 15:00–16:00 overlaps the 15:30 event
        }),
        resolution({ action: "shorten", newDurationMinutes: 30 }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Board review",
          start: "2026-07-13T15:30:00.000Z",
          end: "2026-07-13T16:30:00.000Z",
        },
      ],
    });
    const config = { configurable: { thread_id: "t-shorten" } };

    await graph.invoke(
      {
        threadId: "t-shorten",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 3pm for an hour",
      },
      config,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "shorten the 3pm to 30 min" } }),
      config,
    );
    // 15:00–15:30 no longer overlaps → booked at the shortened length.
    expect(resumed.result.status).toBe("created");
    expect(calendarTool.created[0]?.start).toBe("2026-07-13T15:00:00.000Z");
    expect(calendarTool.created[0]?.end).toBe("2026-07-13T15:30:00.000Z");
  });

  it('moves the conflicting event on "reschedule the internal one" and books the requested time', async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
        }),
        resolution({
          action: "reschedule_existing",
          targetEventSummary: "Internal sync",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e-internal",
          summary: "Internal sync",
          start: "2026-07-13T10:00:00.000Z",
          end: "2026-07-13T10:30:00.000Z",
        },
      ],
    });
    const config = { configurable: { thread_id: "t-reschedule" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-reschedule",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10",
      },
      config,
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("proposal");
    expect(calendarTool.updates).toHaveLength(0); // no unilateral change

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "reschedule the internal one" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    // The existing event was moved out of the way...
    expect(calendarTool.updates).toHaveLength(1);
    expect(calendarTool.updates[0].eventId).toBe("e-internal");
    expect(
      Date.parse(calendarTool.updates[0].patch.start as string),
    ).toBeGreaterThanOrEqual(Date.parse("2026-07-13T10:30:00.000Z"));
    // ...and the requested meeting landed at its original time.
    expect(calendarTool.created[0]?.start).toBe("2026-07-13T10:00:00.000Z");
  });

  it("re-asks once on an unclear reply, then books the picked option", async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
        }),
        resolution({ action: "unclear" }),
        resolution({ action: "pick_option", optionIndex: 1 }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Standup",
          start: "2026-07-13T10:00:00.000Z",
          end: "2026-07-13T10:30:00.000Z",
        },
      ],
    });
    const config = { configurable: { thread_id: "t-unclear" } };

    await graph.invoke(
      {
        threadId: "t-unclear",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10",
      },
      config,
    );
    const reasked: any = await graph.invoke(
      new Command({ resume: { reply: "hmm" } }),
      config,
    );
    expect(reasked.__interrupt__?.[0]?.value?.message).toContain(
      "didn't catch",
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "option 1" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    expect(calendarTool.created).toHaveLength(1);
  });
});

describe("resolution loop — preference violations (case 30)", () => {
  it("flags a request outside working hours and offers in-window slots instead of booking", async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T20:00:00.000Z", // outside 9–18
          timeframe: null,
        }),
        resolution({ action: "pick_option", optionIndex: 1 }),
      ],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: "t-violation" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-violation",
        tenantId: "tenant-1",
        userMessage: "book me with Sarah at 8pm Monday",
      },
      config,
    );
    const message = paused.__interrupt__?.[0]?.value?.message ?? "";
    expect(message).toContain("working hours");
    expect(calendarTool.created).toHaveLength(0); // never silently booked

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "option 1" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    const startHour = new Date(resumed.selectedSlot.start).getUTCHours();
    expect(startHour).toBeGreaterThanOrEqual(9);
    expect(startHour).toBeLessThan(18);
  });
});

describe("resolution loop — dual-timezone rendering (case 4)", () => {
  it("shows proposal options in the principal's AND the attendee's timezone", async () => {
    const { graph } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
          attendeeTimezone: "Australia/Sydney",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Standup",
          start: "2026-07-13T10:00:00.000Z",
          end: "2026-07-13T10:30:00.000Z",
        },
      ],
    });
    const config = { configurable: { thread_id: "t-dual-tz" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-dual-tz",
        tenantId: "tenant-1",
        userMessage: "call with Sarah Monday 10, she's in Sydney",
      },
      config,
    );
    const message = paused.__interrupt__?.[0]?.value?.message ?? "";
    expect(message).toContain("(UTC)");
    expect(message).toContain("(Australia/Sydney)");
  });
});

describe("resolution loop — flight arrivals (case 14)", () => {
  it("flags an onsite meeting too soon after a flight (travel + post-arrival buffer)", async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
          location: "Acme HQ, Singapore",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e-flight",
          summary: "Flight SQ123 arrival",
          start: "2026-07-13T07:00:00.000Z",
          end: "2026-07-13T09:30:00.000Z",
          location: "Changi Airport, Singapore",
        },
      ],
      travelMinutes: 20, // 20 travel + 30 post-arrival = 50 > the 30-min gap
    });
    const config = { configurable: { thread_id: "t-flight" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-flight",
        tenantId: "tenant-1",
        userMessage: "onsite at Acme 10am Monday, I land at 9:30",
      },
      config,
    );
    const message = paused.__interrupt__?.[0]?.value?.message ?? "";
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("proposal");
    expect(message.toLowerCase()).toContain("flight");
    expect(calendarTool.created).toHaveLength(0);
  });

  it("books when the gap covers travel plus the post-arrival buffer", async () => {
    const { graph } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T11:00:00.000Z", // 90-min gap
          timeframe: null,
          location: "Acme HQ, Singapore",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e-flight",
          summary: "Flight SQ123 arrival",
          start: "2026-07-13T07:00:00.000Z",
          end: "2026-07-13T09:30:00.000Z",
          location: "Changi Airport, Singapore",
        },
      ],
      travelMinutes: 20,
    });
    const config = { configurable: { thread_id: "t-flight-ok" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-flight-ok",
        tenantId: "tenant-1",
        userMessage: "onsite at Acme 11am Monday",
      },
      config,
    );
    expect(result.result.status).toBe("created");
  });
});

describe("resolution loop — nothing available (case 5)", () => {
  it("offers the nearest later openings and widens the search on request", async () => {
    // One solid block covering the whole default 14-day window.
    const now = Date.now();
    const blockEnd = new Date(now + 15 * 24 * 3_600_000).toISOString();
    const { graph, calendarTool } = buildGraph({
      intents: [intent(), resolution({ action: "widen" })],
      contacts: knownSarah,
      events: [
        {
          eventId: "e-block",
          summary: "Offsite",
          start: new Date(now - 3_600_000).toISOString(),
          end: blockEnd,
        },
      ],
    });
    const config = { configurable: { thread_id: "t-noslot" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-noslot",
        tenantId: "tenant-1",
        userMessage: "book 30 min with Sarah next week",
      },
      config,
    );
    const message = paused.__interrupt__?.[0]?.value?.message ?? "";
    // Says nothing fits and proposes later alternatives — no bad slot forced.
    expect(message).toContain("Nothing fits");
    expect(message).toMatch(/1\./);
    expect(calendarTool.created).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "widen the search" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    // The booked slot lies beyond the original 14-day window.
    expect(Date.parse(resumed.selectedSlot.start)).toBeGreaterThan(
      now + 14 * 24 * 3_600_000 - 3_600_000,
    );
  });
});
