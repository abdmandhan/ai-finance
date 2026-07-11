import { describe, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import type { ScheduleIntent } from "@/schemas";
import { buildGraph, fakeAuth, intent } from "./schedule.test-utils";

describe("schedule graph (no approval, contacts-aware)", () => {
  it("creates immediately when the contact is known — no pause", async () => {
    const { graph } = buildGraph({
      contacts: [{ name: "Sarah", email: "sarah@example.com" }],
    });
    const config = { configurable: { thread_id: "t-known" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-known",
        tenantId: "tenant-1",
        userMessage: "Schedule 30 min with Sarah next week",
      },
      config,
    );

    expect(result.__interrupt__).toBeUndefined();
    expect(result.result.status).toBe("created");
    expect(result.result.eventId).toBeTruthy();
    expect(result.attendeeEmail).toBe("sarah@example.com");
  });

  it("asks for the email when unknown, then saves the contact and creates", async () => {
    const { graph, contactsTool } = buildGraph({
      // First parse: no email. Second parse (after reply): email present.
      intents: [intent(), intent({ attendeeEmail: "sarah@new.com" })],
      contacts: [],
    });
    const config = { configurable: { thread_id: "t-unknown" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-unknown",
        tenantId: "tenant-1",
        userMessage: "Schedule 30 min with Sarah next week",
      },
      config,
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe("clarification");

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "sarah@new.com" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");

    // New contact was saved to the (stub) book.
    const found = await contactsTool.lookup(fakeAuth, "Sarah");
    expect(found[0]?.email).toBe("sarah@new.com");
  });
});

describe("schedule graph honors the requested date/time", () => {
  const knownSarah = [{ name: "Sarah", email: "sarah@example.com" }];

  it("books the exact requested time (not a default hour, not shifted)", async () => {
    // "tomorrow morning at 10" resolved to Sat 12 Jul 10:00 by the parser.
    const requested = "2026-07-12T10:00:00.000Z";
    const { graph } = buildGraph({
      intents: [
        intent({
          requestedStartIso: requested,
          timeframe: null,
          durationMinutes: 30,
        }),
      ],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: "t-exact" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-exact",
        tenantId: "tenant-1",
        userMessage: "schedule a call with Sarah tomorrow morning at 10",
      },
      config,
    );

    expect(result.result.status).toBe("created");
    expect(result.selectedSlot.start).toBe(requested);
    // Regression guards for the reported bug:
    expect(result.selectedSlot.start).not.toContain("T09:00"); // not snapped to 09:00
    expect(result.selectedSlot.start.startsWith("2026-07-12")).toBe(true); // not shifted to Mon 13
  });

  it("does not skip a weekend when a weekend day is explicitly requested", async () => {
    const saturday = "2026-07-12T10:00:00.000Z"; // 2026-07-12 is a Saturday
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: saturday, timeframe: null })],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: "t-weekend" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-weekend",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Saturday at 10",
      },
      config,
    );
    expect(result.selectedSlot.start).toBe(saturday);
  });

  it("sets the end to start + duration", async () => {
    const requested = "2026-07-12T10:00:00.000Z";
    const { graph } = buildGraph({
      intents: [
        intent({
          requestedStartIso: requested,
          timeframe: null,
          durationMinutes: 45,
        }),
      ],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: "t-dur" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-dur",
        tenantId: "tenant-1",
        userMessage: "meet Sarah tomorrow at 10 for 45 min",
      },
      config,
    );
    expect(result.selectedSlot.end).toBe("2026-07-12T10:45:00.000Z");
  });

  it("falls back to the working-hours scan for vague requests", async () => {
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: null, timeframe: "next week" })],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: "t-vague" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-vague",
        tenantId: "tenant-1",
        userMessage: "schedule with Sarah sometime next week",
      },
      config,
    );
    expect(result.result.status).toBe("created");
    expect(result.selectedSlot.start).toBeTruthy();
  });
});

describe("schedule graph — conflicts and travel time", () => {
  const knownSarah = [{ name: "Sarah", email: "sarah@example.com" }];

  it("pauses with a proposal (does not book) when the requested time overlaps an event, then books the picked option", async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:30:00.000Z",
          timeframe: null,
        }),
        // Second extract: the resolution of the principal's reply.
        {
          action: "pick_option",
          optionIndex: 1,
          newDurationMinutes: null,
          newStartIso: null,
          targetEventSummary: null,
        },
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Standup",
          start: "2026-07-13T10:00:00.000Z",
          end: "2026-07-13T11:00:00.000Z",
        },
      ],
    });
    const config = { configurable: { thread_id: "t-overlap" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-overlap",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10:30",
      },
      config,
    );
    // Held open as a proposal: both events summarized, nothing booked yet.
    const interruptValue = paused.__interrupt__?.[0]?.value;
    expect(interruptValue?.kind).toBe("proposal");
    expect(interruptValue?.message).toContain("Standup");
    expect(interruptValue?.message).toContain("Meeting with Sarah");
    expect(calendarTool.created).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "option 1" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    expect(calendarTool.created).toHaveLength(1);
    // Booked the first offered alternative, not the conflicting time.
    expect(resumed.selectedSlot.start).not.toBe("2026-07-13T10:30:00.000Z");
  });

  it("pauses with a travel proposal when there is not enough travel time from the prior meeting", async () => {
    const { graph, calendarTool } = buildGraph({
      // Requested 10:00 at a far location; prior in-person event ends 09:45 (15 min gap).
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
          location: "Airport, far away",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Client visit",
          start: "2026-07-13T09:00:00.000Z",
          end: "2026-07-13T09:45:00.000Z",
          location: "10 Downing St",
        },
      ],
      travelMinutes: 40, // 40 > 15 min gap → too tight
    });
    const config = { configurable: { thread_id: "t-travel" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-travel",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10 at the airport",
      },
      config,
    );
    const interruptValue = paused.__interrupt__?.[0]?.value;
    expect(interruptValue?.kind).toBe("proposal");
    expect(interruptValue?.message.toLowerCase()).toContain("travel");
    expect(calendarTool.created).toHaveLength(0);
  });

  it("raises no travel conflict for back-to-back video calls (virtual is exempt)", async () => {
    const { graph, calendarTool } = buildGraph({
      // Video call right after another video call — no locations anywhere.
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
          meetingType: "video",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Zoom sync",
          start: "2026-07-13T09:30:00.000Z",
          end: "2026-07-13T09:45:00.000Z",
          location: "https://zoom.us/j/123",
        },
      ],
      travelMinutes: 120, // would block if travel were (wrongly) applied
    });
    const config = { configurable: { thread_id: "t-virtual" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-virtual",
        tenantId: "tenant-1",
        userMessage: "video call with Sarah Monday 10",
      },
      config,
    );
    expect(result.result.status).toBe("created");
    expect(calendarTool.created).toHaveLength(1);
  });

  it("ignores a prior virtual meeting when computing travel to an onsite one (mixed)", async () => {
    const { graph } = buildGraph({
      // Onsite at 10:00; the only prior event is a video call — no travel leg exists.
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
          location: "Acme HQ, Jakarta",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Video standup",
          start: "2026-07-13T09:00:00.000Z",
          end: "2026-07-13T09:40:00.000Z",
          location: "https://meet.google.com/xyz",
        },
      ],
      travelMinutes: 120, // must not be applied to the virtual leg
    });
    const config = { configurable: { thread_id: "t-mixed" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-mixed",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10 at Acme HQ",
      },
      config,
    );
    // 20-min gap ≥ 15-min buffer, and no travel demanded from a video call.
    expect(result.result.status).toBe("created");
  });

  it("books when there is enough travel time and no conflict", async () => {
    const { graph } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:30:00.000Z",
          timeframe: null,
          location: "Airport, far away",
        }),
      ],
      contacts: knownSarah,
      events: [
        {
          eventId: "e1",
          summary: "Client visit",
          start: "2026-07-13T09:00:00.000Z",
          end: "2026-07-13T09:45:00.000Z",
          location: "10 Downing St",
        },
      ],
      travelMinutes: 5, // 5 min travel, 45 min gap → fine
    });
    const config = { configurable: { thread_id: "t-ok" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-ok",
        tenantId: "tenant-1",
        userMessage: "meet Sarah Monday 10:30 at the airport",
      },
      config,
    );
    expect(result.result.status).toBe("created");
    expect(result.selectedSlot.start).toBe("2026-07-13T10:30:00.000Z");
  });
});

describe("schedule graph — lookup (read) questions", () => {
  const lookupIntent = (over: Partial<ScheduleIntent> = {}) =>
    intent({
      intent: "lookup_schedule",
      attendee: null,
      timeframe: null,
      durationMinutes: null,
      rangeStartIso: "2026-07-13T00:00:00.000Z",
      rangeEndIso: "2026-07-14T00:00:00.000Z",
      ...over,
    });
  const dayEvents = [
    {
      eventId: "e1",
      summary: "Standup",
      start: "2026-07-13T10:00:00.000Z",
      end: "2026-07-13T10:15:00.000Z",
    },
    {
      eventId: "e2",
      summary: "1:1 with Sarah",
      start: "2026-07-13T14:00:00.000Z",
      end: "2026-07-13T14:30:00.000Z",
    },
  ];

  it("answers with the day's events — nothing booked, no pause", async () => {
    const { graph } = buildGraph({
      intents: [lookupIntent()],
      events: dayEvents,
    });
    const config = { configurable: { thread_id: "t-lookup" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-lookup",
        tenantId: "tenant-1",
        userMessage: "what is my schedule for tomorrow?",
      },
      config,
    );

    expect(result.__interrupt__).toBeUndefined();
    expect(result.result.status).toBe("answered");
    expect(result.result.summary).toContain("2 meetings");
    expect(result.result.summary).toContain("Standup");
    expect(result.result.summary).toContain("1:1 with Sarah");
    expect(result.result.eventId).toBeUndefined();
  });

  it("answers 'no meetings' for an empty calendar", async () => {
    const { graph } = buildGraph({ intents: [lookupIntent()], events: [] });
    const result: any = await graph.invoke(
      {
        threadId: "t-lookup-empty",
        tenantId: "tenant-1",
        userMessage: "do I have meetings tomorrow?",
      },
      { configurable: { thread_id: "t-lookup-empty" } },
    );
    expect(result.result.status).toBe("answered");
    expect(result.result.summary).toContain("no meetings");
  });

  it("filters by attendee for 'when is my next meeting with Sarah?'", async () => {
    const { graph } = buildGraph({
      intents: [lookupIntent({ attendee: "Sarah" })],
      events: dayEvents,
    });
    const result: any = await graph.invoke(
      {
        threadId: "t-lookup-sarah",
        tenantId: "tenant-1",
        userMessage: "when is my next meeting with Sarah?",
      },
      { configurable: { thread_id: "t-lookup-sarah" } },
    );
    expect(result.result.status).toBe("answered");
    expect(result.result.summary).toContain("1:1 with Sarah");
    expect(result.result.summary).not.toContain("Standup");
  });

  it("defaults to the coming days when no window was stated", async () => {
    // Event within the next 7 days of "now" (test runs against real clock).
    const soon = new Date(Date.now() + 24 * 3_600_000);
    const soonEnd = new Date(soon.getTime() + 30 * 60_000);
    const { graph } = buildGraph({
      intents: [lookupIntent({ rangeStartIso: null, rangeEndIso: null })],
      events: [
        {
          eventId: "e3",
          summary: "Planning",
          start: soon.toISOString(),
          end: soonEnd.toISOString(),
        },
      ],
    });
    const result: any = await graph.invoke(
      {
        threadId: "t-lookup-default",
        tenantId: "tenant-1",
        userMessage: "what's on my calendar?",
      },
      { configurable: { thread_id: "t-lookup-default" } },
    );
    expect(result.result.status).toBe("answered");
    expect(result.result.summary).toContain("Planning");
  });
});
