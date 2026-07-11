import { describe, expect, it } from "vitest";
import {
  detectConflicts,
  findFreeSlots,
  formatEventLine,
  formatSchedule,
  formatSlotDual,
  isFlightLike,
  isPhysical,
  slotViolation,
  type ScheduleEntry,
  type SchedulingPrefs,
} from "./scheduling";

const prefs: SchedulingPrefs = {
  bufferMinutes: 15,
  workingHoursStart: 9,
  workingHoursEnd: 18,
  timezone: "UTC",
};

// A weekday inside working hours (2026-07-13 is a Monday).
const D = (h: number, m = 0) =>
  `2026-07-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("detectConflicts", () => {
  const ev = [{ start: D(10), end: D(11) }];
  it("flags an overlapping interval", () => {
    expect(detectConflicts(ev, D(10, 30), D(11, 30))).toHaveLength(1);
  });
  it("ignores an adjacent (touching) interval", () => {
    expect(detectConflicts(ev, D(11), D(12))).toHaveLength(0);
    expect(detectConflicts(ev, D(9), D(10))).toHaveLength(0);
  });
});

describe("isPhysical", () => {
  it("true for an address, false for a URL / empty", () => {
    expect(isPhysical("10 Downing St")).toBe(true);
    expect(isPhysical("https://meet.google.com/x")).toBe(false);
    expect(isPhysical("")).toBe(false);
    expect(isPhysical(undefined)).toBe(false);
  });
});

describe("findFreeSlots", () => {
  it("finds a slot in the gap, respecting buffer", () => {
    const slots = findFreeSlots(
      [{ start: D(9), end: D(10) }],
      D(9),
      D(12),
      30,
      prefs,
      3,
    );
    // First slot starts at/after 10:00 + 15m buffer.
    expect(Date.parse(slots[0].start)).toBeGreaterThanOrEqual(
      Date.parse(D(10, 15)),
    );
  });

  it("pads the busy tail by travel time when larger than buffer", () => {
    // Event ends 10:00; travel 60m > buffer 15m → nothing bookable until >= 11:00.
    const slots = findFreeSlots(
      [{ start: D(9), end: D(10), travelTimeAfterMs: 60 * 60_000 }],
      D(9),
      D(13),
      30,
      prefs,
      3,
    );
    expect(Date.parse(slots[0].start)).toBeGreaterThanOrEqual(
      Date.parse(D(11)),
    );
  });

  it("excludes slots outside working hours", () => {
    const slots = findFreeSlots([], D(6), D(23), 30, prefs, 10);
    for (const s of slots) {
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse(D(9)));
      expect(Date.parse(s.end)).toBeLessThanOrEqual(Date.parse(D(18)));
    }
  });
});

describe("slotViolation", () => {
  it("null inside working hours on a plain weekday", () => {
    expect(slotViolation(Date.parse(D(10)), Date.parse(D(10, 30)), prefs)).toBe(
      null,
    );
  });

  it("flags working hours at minute precision", () => {
    // 17:45–18:15 spills 15 min past an 18:00 close.
    const v = slotViolation(Date.parse(D(17, 45)), Date.parse(D(18, 15)), prefs);
    expect(v?.kind).toBe("working_hours");
    // Ending exactly at close is fine.
    expect(
      slotViolation(Date.parse(D(17, 30)), Date.parse(D(18)), prefs),
    ).toBe(null);
  });

  it("flags a no-meeting day by name", () => {
    // 2026-07-13 is a Monday (weekday 1).
    const v = slotViolation(Date.parse(D(10)), Date.parse(D(10, 30)), {
      ...prefs,
      noMeetingDays: [1],
    });
    expect(v?.kind).toBe("no_meeting_day");
    expect(v?.message).toContain("Monday");
  });

  it("flags a day outside working days", () => {
    const v = slotViolation(Date.parse(D(10)), Date.parse(D(10, 30)), {
      ...prefs,
      workingDays: [2, 3, 4], // Tue–Thu
    });
    expect(v?.kind).toBe("non_working_day");
  });

  it("flags lunch overlap but not a slot touching its edge", () => {
    const lunch = { startMinutes: 12 * 60, endMinutes: 13 * 60 };
    const v = slotViolation(Date.parse(D(12, 30)), Date.parse(D(13)), {
      ...prefs,
      lunch,
    });
    expect(v?.kind).toBe("lunch");
    expect(v?.message).toContain("12:00–13:00");
    expect(
      slotViolation(Date.parse(D(13)), Date.parse(D(13, 30)), {
        ...prefs,
        lunch,
      }),
    ).toBe(null);
  });

  it("flags a focus block only on its days", () => {
    const focus = {
      startMinutes: 9 * 60,
      endMinutes: 11 * 60,
      days: [1],
      label: "deep work",
    };
    const v = slotViolation(Date.parse(D(9, 30)), Date.parse(D(10)), {
      ...prefs,
      focusBlocks: [focus],
    });
    expect(v?.kind).toBe("focus_block");
    expect(v?.message).toContain("deep work");
    // Same time Tuesday (day 2) is fine.
    const tue = (h: number, m = 0) =>
      Date.parse(
        `2026-07-14T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`,
      );
    expect(
      slotViolation(tue(9, 30), tue(10), { ...prefs, focusBlocks: [focus] }),
    ).toBe(null);
  });
});

describe("findFreeSlots with lunch/focus/day prefs", () => {
  it("skips the lunch window", () => {
    const slots = findFreeSlots([], D(11), D(14), 60, {
      ...prefs,
      lunch: { startMinutes: 12 * 60, endMinutes: 13 * 60 },
    });
    for (const s of slots) {
      const startMin =
        new Date(s.start).getUTCHours() * 60 + new Date(s.start).getUTCMinutes();
      const endMin = startMin + 60;
      expect(startMin >= 13 * 60 || endMin <= 12 * 60).toBe(true);
    }
  });

  it("skips no-meeting days entirely", () => {
    // Monday is meeting-free → first slot lands on Tuesday Jul 14.
    const slots = findFreeSlots([], D(9), "2026-07-15T00:00:00.000Z", 30, {
      ...prefs,
      noMeetingDays: [1],
    });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start.startsWith("2026-07-14")).toBe(true);
  });
});

describe("formatSlotDual", () => {
  const slot = { start: D(10), end: D(10, 45) };

  it("renders a single timezone when no attendee tz", () => {
    const text = formatSlotDual(slot, "UTC");
    expect(text).toBe("Mon, Jul 13 10:00–10:45");
  });

  it("renders both timezones when they differ", () => {
    const text = formatSlotDual(slot, "Asia/Singapore", "Australia/Sydney");
    // 10:00Z = 18:00 SGT (UTC+8) = 20:00 AEST (UTC+10).
    expect(text).toContain("18:00–18:45 (Asia/Singapore)");
    expect(text).toContain("20:00–20:45 (Australia/Sydney)");
  });

  it("collapses to one rendering when zones match", () => {
    expect(formatSlotDual(slot, "UTC", "UTC")).toBe("Mon, Jul 13 10:00–10:45");
  });
});

describe("formatEventLine", () => {
  it("renders when, what and where", () => {
    const line = formatEventLine(
      { summary: "Board review", start: D(13), end: D(14), location: "HQ" },
      "UTC",
    );
    expect(line).toBe("Mon, Jul 13 13:00–14:00 — Board review (@ HQ)");
  });
});

describe("isFlightLike", () => {
  it("matches flight keywords and airline codes", () => {
    expect(isFlightLike({ summary: "Flight to SIN" })).toBe(true);
    expect(isFlightLike({ summary: "SQ123 arrival" })).toBe(true);
    expect(isFlightLike({ summary: "Pickup", location: "Changi Airport" })).toBe(
      true,
    );
    expect(isFlightLike({ summary: "Landing in Sydney" })).toBe(true);
  });
  it("ignores ordinary meetings", () => {
    expect(isFlightLike({ summary: "Board review", location: "HQ" })).toBe(
      false,
    );
    expect(isFlightLike({ summary: "1:1 with Sarah" })).toBe(false);
  });
});

describe("formatSchedule", () => {
  const events: ScheduleEntry[] = [
    { summary: "Board review", start: D(13), end: D(14), location: "HQ" },
    { summary: "1:1 with Sarah", start: D(9), end: D(9, 30) },
  ];
  const dayStart = "2026-07-13T00:00:00.000Z";
  const dayEnd = "2026-07-14T00:00:00.000Z";

  it("says no meetings for an empty window", () => {
    const text = formatSchedule([], dayStart, dayEnd, "UTC");
    expect(text).toContain("no meetings");
    expect(text).toContain("Mon, Jul 13");
  });

  it("lists events sorted by start time in the given timezone", () => {
    const text = formatSchedule(events, dayStart, dayEnd, "UTC");
    expect(text).toContain("2 meetings");
    const lines = text.split("\n");
    expect(lines[1]).toContain("1:1 with Sarah"); // 09:00 sorts before 13:00
    expect(lines[1]).toContain("09:00–09:30");
    expect(lines[2]).toContain("Board review");
    expect(lines[2]).toContain("(@ HQ)");
  });

  it("renders times in a non-UTC timezone", () => {
    // 09:00Z = 16:00 in Asia/Jakarta (UTC+7).
    const text = formatSchedule([events[1]], dayStart, dayEnd, "Asia/Jakarta");
    expect(text).toContain("16:00–16:30");
  });

  it("filters by attendee (case-insensitive summary match)", () => {
    const text = formatSchedule(events, dayStart, dayEnd, "UTC", "sarah");
    expect(text).toContain("1 meeting with sarah");
    expect(text).toContain("1:1 with Sarah");
    expect(text).not.toContain("Board review");
  });

  it("reports no meetings with the person when the filter matches nothing", () => {
    const text = formatSchedule(events, dayStart, dayEnd, "UTC", "Bob");
    expect(text).toContain("no meetings with Bob");
  });

  it("caps long lists with an overflow line", () => {
    const many: ScheduleEntry[] = Array.from({ length: 25 }, (_, i) => ({
      summary: `Meeting ${i}`,
      start: D(9, i),
      end: D(9, i + 1),
    }));
    const text = formatSchedule(many, dayStart, dayEnd, "UTC");
    expect(text).toContain("...and 5 more");
    expect(text.split("\n")).toHaveLength(1 + 20 + 1); // header + 20 lines + overflow
  });
});
