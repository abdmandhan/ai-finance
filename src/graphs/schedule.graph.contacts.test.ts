/**
 * Contact-management flows (test cases 17, 18, 20, 21): saving a contact on
 * request, capturing one from pasted text, disambiguating between namesakes,
 * and confirming an email change.
 */
import { describe, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import type { ContactExtraction } from "@/schemas";
import { buildGraph, fakeAuth, intent } from "./schedule.test-utils";

function contactExtraction(
  over: Partial<ContactExtraction> = {},
): ContactExtraction {
  return {
    name: "Sarah Lim",
    email: "sarah@acme.com",
    company: null,
    timezone: null,
    isEmailUpdate: false,
    clarificationQuestion: null,
    ...over,
  };
}

describe("schedule graph — contact management", () => {
  it("saves a contact with name, email and org on request (case 17)", async () => {
    const { graph, contactsTool } = buildGraph({
      intents: [
        intent({ intent: "save_contact" }),
        contactExtraction({ company: "Acme" }),
      ],
    });
    const config = { configurable: { thread_id: "t-save" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-save",
        tenantId: "tenant-1",
        userMessage: "save Sarah Lim sarah@acme.com to contacts",
      },
      config,
    );
    expect(result.result.status).toBe("answered");
    expect(result.result.summary).toContain("sarah@acme.com");
    const rows = await contactsTool.lookup(fakeAuth, "Sarah Lim");
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe("Acme");
  });

  it("captures name + email from a pasted signature (case 18)", async () => {
    const { graph, contactsTool } = buildGraph({
      intents: [
        intent({ intent: "save_contact" }),
        contactExtraction({
          name: "Priya Sharma",
          email: "priya@initech.com",
          company: "Initech",
        }),
      ],
    });
    const config = { configurable: { thread_id: "t-signature" } };

    const result: any = await graph.invoke(
      {
        threadId: "t-signature",
        tenantId: "tenant-1",
        userMessage:
          "keep this contact:\n--\nPriya Sharma\nHead of Ops, Initech\npriya@initech.com",
      },
      config,
    );
    expect(result.result.status).toBe("answered");
    const rows = await contactsTool.lookup(fakeAuth, "Priya");
    expect(rows[0]?.email).toBe("priya@initech.com");
  });

  it("asks which Sarah (showing org + email) and uses the picked one (case 20)", async () => {
    const { graph, calendarTool } = buildGraph({
      intents: [
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
        }),
        // Re-parse after the clarification reply.
        intent({
          requestedStartIso: "2026-07-13T10:00:00.000Z",
          timeframe: null,
        }),
      ],
      contacts: [
        { name: "Sarah", email: "sarah@acme.com", company: "Acme" },
        { name: "Sarah", email: "sarah@beta.io", company: "Beta" },
      ],
    });
    const config = { configurable: { thread_id: "t-two-sarahs" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-two-sarahs",
        tenantId: "tenant-1",
        userMessage: "invite Sarah to a call Monday 10",
      },
      config,
    );
    const question = paused.__interrupt__?.[0]?.value?.message ?? "";
    // Both candidates listed with org + email — no guessing.
    expect(question).toContain("Acme");
    expect(question).toContain("sarah@acme.com");
    expect(question).toContain("Beta");
    expect(question).toContain("sarah@beta.io");
    expect(calendarTool.created).toHaveLength(0);

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "the Acme one" } }),
      config,
    );
    expect(resumed.result.status).toBe("created");
    expect(resumed.attendeeEmail).toBe("sarah@acme.com");
  });

  it("confirms an email change, then updates the existing row — no duplicate (case 21)", async () => {
    const { graph, contactsTool, extract } = buildGraph({
      intents: [
        intent({ intent: "save_contact" }),
        contactExtraction({ email: "sarah@newco.com", isEmailUpdate: true }),
        // The node re-runs from the top on resume → extraction repeats.
        contactExtraction({ email: "sarah@newco.com", isEmailUpdate: true }),
      ],
      contacts: [
        { name: "Sarah Lim", email: "sarah@acme.com", company: "Acme" },
      ],
    });
    const config = { configurable: { thread_id: "t-email-update" } };

    const paused: any = await graph.invoke(
      {
        threadId: "t-email-update",
        tenantId: "tenant-1",
        userMessage: "Sarah's email is now sarah@newco.com",
      },
      config,
    );
    const question = paused.__interrupt__?.[0]?.value?.message ?? "";
    expect(question).toContain("sarah@acme.com");
    expect(question).toContain("sarah@newco.com");

    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "yes", approved: true } }),
      config,
    );
    expect(resumed.result.status).toBe("answered");
    expect(resumed.result.summary).toContain("sarah@newco.com");
    const rows = await contactsTool.lookup(fakeAuth, "Sarah Lim");
    expect(rows).toHaveLength(1); // updated in place, not appended
    expect(rows[0].email).toBe("sarah@newco.com");
    expect(rows[0].company).toBe("Acme"); // merge kept the old fields
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it("keeps the old email when the change is declined", async () => {
    const { graph, contactsTool } = buildGraph({
      intents: [
        intent({ intent: "save_contact" }),
        contactExtraction({ email: "sarah@newco.com", isEmailUpdate: true }),
        contactExtraction({ email: "sarah@newco.com", isEmailUpdate: true }),
      ],
      contacts: [{ name: "Sarah Lim", email: "sarah@acme.com" }],
    });
    const config = { configurable: { thread_id: "t-email-decline" } };

    await graph.invoke(
      {
        threadId: "t-email-decline",
        tenantId: "tenant-1",
        userMessage: "update Sarah's email to sarah@newco.com",
      },
      config,
    );
    const resumed: any = await graph.invoke(
      new Command({ resume: { reply: "no", approved: false } }),
      config,
    );
    expect(resumed.result.status).toBe("cancelled");
    expect((await contactsTool.lookup(fakeAuth, "Sarah Lim"))[0].email).toBe(
      "sarah@acme.com",
    );
  });
});
