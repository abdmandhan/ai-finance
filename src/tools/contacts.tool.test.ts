import { describe, expect, it } from "vitest";
import type { CalendarAuth } from "@/services";
import { StubContactsTool } from "./contacts.tool";

const auth: CalendarAuth = {
  accessToken: "x",
  provider: "google",
  calendarId: "primary",
  emailAddress: "me@example.com",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

describe("StubContactsTool.save (mirrors Drive dedup semantics — case 22)", () => {
  it("re-saving the same email updates the row, never appends", async () => {
    const tool = new StubContactsTool([
      { name: "Sarah Lim", email: "sarah@acme.com" },
    ]);
    const res = await tool.save(auth, {
      name: "Sarah Lim",
      email: "sarah@acme.com",
      company: "Acme",
    });
    expect(res.action).toBe("updated");
    const rows = await tool.lookup(auth, "Sarah");
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe("Acme"); // merged, not duplicated
  });

  it("a unique name match with a new email updates the existing row", async () => {
    const tool = new StubContactsTool([
      { name: "Sarah Lim", email: "sarah@acme.com" },
    ]);
    const res = await tool.save(auth, {
      name: "Sarah Lim",
      email: "sarah@newco.com",
    });
    expect(res.action).toBe("updated");
    const rows = await tool.lookup(auth, "Sarah Lim");
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("sarah@newco.com");
  });

  it("multiple name matches ask for disambiguation instead of guessing", async () => {
    const tool = new StubContactsTool([
      { name: "Sarah", email: "sarah@acme.com", company: "Acme" },
      { name: "Sarah", email: "sarah@beta.io", company: "Beta" },
    ]);
    const res = await tool.save(auth, {
      name: "Sarah",
      email: "sarah@newco.com",
    });
    expect(res.action).toBe("needs_disambiguation");
    if (res.action === "needs_disambiguation") {
      expect(res.matches).toHaveLength(2);
    }
    // Nothing was written.
    expect(await tool.lookup(auth, "Sarah")).toHaveLength(2);
  });

  it("an unknown contact is appended", async () => {
    const tool = new StubContactsTool([]);
    const res = await tool.save(auth, {
      name: "John Tan",
      email: "john@globex.com",
      company: "Globex",
    });
    expect(res.action).toBe("created");
    expect((await tool.lookup(auth, "John"))[0]?.company).toBe("Globex");
  });
});
