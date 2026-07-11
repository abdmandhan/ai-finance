/**
 * Preference flows (test cases 23–29, 31–33): saving working days/hours,
 * buffers, lunch, focus blocks and timezone; applying them silently; one-off
 * overrides; learning from corrections; and reading preferences back.
 */
import { describe, expect, it } from "vitest";
import type { PreferenceExtraction } from "@/schemas";
import { InMemoryPreferencesTool } from "@/tools";
import { buildGraph, intent } from "./schedule.test-utils";

function prefExtraction(
  over: Partial<PreferenceExtraction> = {},
): PreferenceExtraction {
  return {
    kind: null,
    startTime: null,
    endTime: null,
    days: null,
    bufferMinutes: null,
    timezone: null,
    label: null,
    clarificationQuestion: null,
    ...over,
  };
}

const KEY = { tenantId: "tenant-1", userId: "user-1" };

async function runPreferenceMessage(
  message: string,
  extraction: PreferenceExtraction,
  preferencesTool = new InMemoryPreferencesTool(),
) {
  const { graph } = buildGraph({
    intents: [intent({ intent: "set_preference" }), extraction],
    preferencesTool,
  });
  const result: any = await graph.invoke(
    {
      threadId: "t-pref",
      tenantId: KEY.tenantId,
      userId: KEY.userId,
      userMessage: message,
    },
    { configurable: { thread_id: "t-pref" } },
  );
  return { result, preferencesTool };
}

describe("schedule graph — saving preferences", () => {
  it("saves working days + hours in one go (case 23)", async () => {
    const { result, preferencesTool } = await runPreferenceMessage(
      "I work Mon–Thu 10–4",
      prefExtraction({
        kind: "working_hours",
        startTime: "10:00",
        endTime: "16:00",
        days: ["monday", "tuesday", "wednesday", "thursday"],
      }),
    );
    expect(result.result.status).toBe("answered");
    const saved = await preferencesTool.getAll(KEY);
    expect(saved.working_hours).toEqual({ startHour: 10, endHour: 16 });
    expect(saved.working_days).toEqual([1, 2, 3, 4]);
  });

  it('saves "no meetings on Fridays" (case 23)', async () => {
    const { preferencesTool } = await runPreferenceMessage(
      "no meetings on Fridays",
      prefExtraction({ kind: "no_meeting_days", days: ["friday"] }),
    );
    expect((await preferencesTool.getAll(KEY)).no_meeting_days).toEqual([5]);
  });

  it("saves a per-meeting buffer (case 24)", async () => {
    const { preferencesTool } = await runPreferenceMessage(
      "I want 20 min between every meeting",
      prefExtraction({ kind: "buffer_minutes", bufferMinutes: 20 }),
    );
    expect((await preferencesTool.getAll(KEY)).buffer_minutes).toBe(20);
  });

  it("saves the lunch break (case 25)", async () => {
    const { preferencesTool } = await runPreferenceMessage(
      "block 12:30–1:30 for lunch daily",
      prefExtraction({ kind: "lunch", startTime: "12:30", endTime: "13:30" }),
    );
    expect((await preferencesTool.getAll(KEY)).lunch).toEqual({
      startMinutes: 750,
      endMinutes: 810,
    });
  });

  it("saves a focus block (case 26)", async () => {
    const { preferencesTool } = await runPreferenceMessage(
      "block 8–10am every day for deep work",
      prefExtraction({
        kind: "focus_blocks",
        startTime: "08:00",
        endTime: "10:00",
        label: "deep work",
      }),
    );
    expect((await preferencesTool.getAll(KEY)).focus_blocks).toEqual([
      { startMinutes: 480, endMinutes: 600, label: "deep work" },
    ]);
  });

  it("saves the timezone (case 27)", async () => {
    const { preferencesTool } = await runPreferenceMessage(
      "I'm in Singapore time",
      prefExtraction({ kind: "timezone", timezone: "Asia/Singapore" }),
    );
    expect((await preferencesTool.getAll(KEY)).timezone).toBe(
      "Asia/Singapore",
    );
  });

  it("updates a preference in place — no duplicate (case 29)", async () => {
    const tool = new InMemoryPreferencesTool();
    await runPreferenceMessage(
      "my lunch is 12–1",
      prefExtraction({ kind: "lunch", startTime: "12:00", endTime: "13:00" }),
      tool,
    );
    await runPreferenceMessage(
      "actually make lunch 12:30–1:30",
      prefExtraction({ kind: "lunch", startTime: "12:30", endTime: "13:30" }),
      tool,
    );
    const entries = await tool.list(KEY);
    expect(entries.filter((e) => e.kind === "lunch")).toHaveLength(1);
    expect((await tool.getAll(KEY)).lunch).toEqual({
      startMinutes: 750,
      endMinutes: 810,
    });
  });

  it("learns from a correction (case 32)", async () => {
    const { result, preferencesTool } = await runPreferenceMessage(
      "you booked over my lunch — don't do that again",
      prefExtraction({ kind: "lunch" }), // no times stated → 12:00–13:00 default
    );
    expect(result.result.status).toBe("answered");
    expect((await preferencesTool.getAll(KEY)).lunch).toEqual({
      startMinutes: 720,
      endMinutes: 780,
    });
  });
});

describe("schedule graph — applying preferences", () => {
  it("applies saved working hours silently on a vague request (case 28)", async () => {
    const preferencesTool = new InMemoryPreferencesTool();
    await preferencesTool.set(KEY, "working_hours", {
      startHour: 10,
      endHour: 16,
    });
    const { graph, extract } = buildGraph({
      intents: [intent()], // vague "next week" request; no pref talk
      contacts: [{ name: "Sarah", email: "sarah@example.com" }],
      preferencesTool,
    });

    const result: any = await graph.invoke(
      {
        threadId: "t-apply",
        tenantId: KEY.tenantId,
        userId: KEY.userId,
        userMessage: "set up a 30-min call with Sarah next week",
      },
      { configurable: { thread_id: "t-apply" } },
    );
    expect(result.result.status).toBe("created");
    // Slot honors the saved 10:00–16:00 window (deps tz = UTC) — no re-ask happened.
    const startHour = new Date(result.selectedSlot.start).getUTCHours();
    expect(startHour).toBeGreaterThanOrEqual(10);
    expect(startHour).toBeLessThan(16);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("honors a one-off override without changing the saved default (case 31)", async () => {
    const preferencesTool = new InMemoryPreferencesTool();
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T19:00:00.000Z", // outside 9–18
          timeframe: null,
          oneOffOverride: true,
        }),
      ],
      contacts: [{ name: "Sarah", email: "sarah@example.com" }],
      preferencesTool,
    });

    const result: any = await graph.invoke(
      {
        threadId: "t-override",
        tenantId: KEY.tenantId,
        userId: KEY.userId,
        userMessage: "just this once, 7pm Monday is fine",
      },
      { configurable: { thread_id: "t-override" } },
    );
    expect(result.result.status).toBe("created");
    expect(calendarTool.created[0]?.start).toBe("2026-07-13T19:00:00.000Z");
    // The standing defaults were not touched.
    expect(await preferencesTool.list(KEY)).toHaveLength(0);
  });
});

describe("schedule graph — recalling preferences (case 33)", () => {
  it("reads back everything saved", async () => {
    const preferencesTool = new InMemoryPreferencesTool();
    await preferencesTool.set(KEY, "working_hours", {
      startHour: 9,
      endHour: 18,
    });
    await preferencesTool.set(KEY, "lunch", {
      startMinutes: 720,
      endMinutes: 780,
    });
    await preferencesTool.set(KEY, "no_meeting_days", [5]);
    const { graph } = buildGraph({
      intents: [intent({ intent: "list_preferences" })],
      preferencesTool,
    });

    const result: any = await graph.invoke(
      {
        threadId: "t-recall",
        tenantId: KEY.tenantId,
        userId: KEY.userId,
        userMessage: "what scheduling preferences do you have for me?",
      },
      { configurable: { thread_id: "t-recall" } },
    );
    expect(result.result.status).toBe("answered");
    expect(result.result.summary).toContain("09:00–18:00");
    expect(result.result.summary).toContain("12:00–13:00");
    expect(result.result.summary).toContain("Fri");
  });

  it("says so when nothing is saved yet", async () => {
    const { graph } = buildGraph({
      intents: [intent({ intent: "list_preferences" })],
    });
    const result: any = await graph.invoke(
      {
        threadId: "t-recall-empty",
        tenantId: KEY.tenantId,
        userId: KEY.userId,
        userMessage: "what preferences do you have for me?",
      },
      { configurable: { thread_id: "t-recall-empty" } },
    );
    expect(result.result.summary).toContain("no saved scheduling preferences");
  });
});
