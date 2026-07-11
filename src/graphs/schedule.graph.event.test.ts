/**
 * Event-content flows (test cases 7, 8): all attendees on the invite, context
 * notes in the description, and video link vs physical address handling.
 */
import { describe, expect, it } from "vitest";
import { buildGraph, intent } from "./schedule.test-utils";

const knownSarah = [{ name: "Sarah", email: "sarah@example.com" }];
const REQUESTED = "2026-07-13T10:00:00.000Z";

async function book(over: Parameters<typeof intent>[0]) {
  const built = buildGraph({
    intents: [
      intent({ requestedStartIso: REQUESTED, timeframe: null, ...over }),
    ],
    contacts: knownSarah,
  });
  const result: any = await built.graph.invoke(
    {
      threadId: "t-event",
      tenantId: "tenant-1",
      userMessage: "book it",
    },
    { configurable: { thread_id: "t-event" } },
  );
  return { ...built, result };
}

describe("schedule graph — event contents", () => {
  it("puts every attendee and the context notes on the event (case 7)", async () => {
    const { result, calendarTool } = await book({
      additionalAttendeeEmails: ["john@globex.com"],
      notes: "Q3 partnership kickoff — bring the draft term sheet",
    });
    expect(result.result.status).toBe("created");
    const created = calendarTool.created[0];
    expect(created.attendees).toEqual([
      { email: "sarah@example.com", name: "Sarah" },
      { email: "john@globex.com" },
    ]);
    expect(created.description).toContain("Q3 partnership kickoff");
  });

  it("requests a Meet link for a video meeting with no explicit link (case 8)", async () => {
    const { result, calendarTool } = await book({ meetingType: "video" });
    expect(result.result.status).toBe("created");
    const created = calendarTool.created[0];
    expect(created.createMeetLink).toBe(true);
    expect(created.location).toBeUndefined();
    expect(result.result.summary).toContain("video");
  });

  it("uses the explicit video link instead of creating one (case 8)", async () => {
    const { calendarTool } = await book({
      meetingType: "video",
      videoLink: "https://zoom.us/j/12345",
    });
    const created = calendarTool.created[0];
    expect(created.createMeetLink).toBe(false);
    expect(created.description).toContain("Join: https://zoom.us/j/12345");
  });

  it("sets the address for a physical meeting (case 8, feeds travel checks)", async () => {
    const { calendarTool } = await book({
      meetingType: "in_person",
      location: "Acme's office, 1 Raffles Place",
    });
    const created = calendarTool.created[0];
    expect(created.location).toBe("Acme's office, 1 Raffles Place");
    expect(created.createMeetLink).toBe(false);
  });
});
