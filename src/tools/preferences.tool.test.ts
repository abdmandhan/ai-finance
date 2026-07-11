import { describe, expect, it } from "vitest";
import { mergePrefs, postArrivalBufferMinutes } from "@/nodes/shared";
import { InMemoryPreferencesTool } from "./preferences.tool";

const KEY = { tenantId: "t1", userId: "u1" };

describe("InMemoryPreferencesTool", () => {
  it("set + getAll round-trips a value", async () => {
    const tool = new InMemoryPreferencesTool();
    await tool.set(KEY, "buffer_minutes", 15);
    expect((await tool.getAll(KEY)).buffer_minutes).toBe(15);
  });

  it("updates in place — no duplicate entry (case 29)", async () => {
    const tool = new InMemoryPreferencesTool();
    await tool.set(KEY, "lunch", { startMinutes: 720, endMinutes: 780 });
    await tool.set(KEY, "lunch", { startMinutes: 750, endMinutes: 810 });
    const entries = await tool.list(KEY);
    expect(entries.filter((e) => e.kind === "lunch")).toHaveLength(1);
    expect(entries[0].value).toEqual({ startMinutes: 750, endMinutes: 810 });
  });

  it("isolates tenants and users", async () => {
    const tool = new InMemoryPreferencesTool();
    await tool.set(KEY, "timezone", "Asia/Singapore");
    expect(await tool.getAll({ tenantId: "t1", userId: "other" })).toEqual({});
    expect(await tool.getAll({ tenantId: "t2", userId: "u1" })).toEqual({});
  });

  it("lists entries with timestamps", async () => {
    const tool = new InMemoryPreferencesTool();
    await tool.set(KEY, "timezone", "Asia/Singapore");
    const [entry] = await tool.list(KEY);
    expect(entry.kind).toBe("timezone");
    expect(Date.parse(entry.updatedAt)).not.toBeNaN();
  });
});

describe("mergePrefs", () => {
  const base = {
    bufferMinutes: 15,
    workingHoursStart: 9,
    workingHoursEnd: 18,
    timezone: "Asia/Jakarta",
  };

  it("falls back to config when nothing saved", () => {
    const p = mergePrefs(base, null);
    expect(p.bufferMinutes).toBe(15);
    expect(p.workingHoursStart).toBe(9);
    expect(p.timezone).toBe("Asia/Jakarta");
    expect(p.lunch).toBeUndefined();
  });

  it("saved preferences win over config", () => {
    const p = mergePrefs(base, {
      buffer_minutes: 20,
      working_hours: { startHour: 10, endHour: 16 },
      timezone: "Asia/Singapore",
      no_meeting_days: [5],
      working_days: [1, 2, 3, 4],
      lunch: { startMinutes: 720, endMinutes: 780 },
      focus_blocks: [{ startMinutes: 480, endMinutes: 600, label: "deep work" }],
    });
    expect(p.bufferMinutes).toBe(20);
    expect(p.workingHoursStart).toBe(10);
    expect(p.workingHoursEnd).toBe(16);
    expect(p.timezone).toBe("Asia/Singapore");
    expect(p.noMeetingDays).toEqual([5]);
    expect(p.workingDays).toEqual([1, 2, 3, 4]);
    expect(p.lunch).toEqual({ startMinutes: 720, endMinutes: 780 });
    expect(p.focusBlocks?.[0].label).toBe("deep work");
  });

  it("ignores malformed saved values", () => {
    const p = mergePrefs(base, {
      buffer_minutes: "twenty",
      lunch: { startMinutes: "noon" },
      focus_blocks: [{ nonsense: true }],
    });
    expect(p.bufferMinutes).toBe(15);
    expect(p.lunch).toBeUndefined();
    expect(p.focusBlocks).toEqual([]);
  });
});

describe("postArrivalBufferMinutes", () => {
  it("defaults to 30 and honors the saved pref", () => {
    expect(postArrivalBufferMinutes(null)).toBe(30);
    expect(postArrivalBufferMinutes({ post_arrival_buffer_minutes: 45 })).toBe(
      45,
    );
  });
});
