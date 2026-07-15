import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  inboundMessageSchema,
  outboundMessageSchema,
  progressEventSchema,
} from "./chat.schema";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "kafka",
);

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(join(fixturesDir, name), "utf8"));
}

describe("graph-local Kafka fixtures", () => {
  it("parses inbound text", () => {
    expect(() =>
      inboundMessageSchema.parse(loadFixture("inbound-text.json")),
    ).not.toThrow();
  });

  it.each([
    "outbound-ok.json",
    "outbound-approval-pending.json",
    "outbound-approval-completed-payment.json",
    "outbound-document.json",
    "outbound-invoice-pdf.json",
  ])("parses outbound fixture %s", (name) => {
    expect(() => outboundMessageSchema.parse(loadFixture(name))).not.toThrow();
  });

  it("parses progress event", () => {
    expect(() =>
      progressEventSchema.parse(loadFixture("progress-event.json")),
    ).not.toThrow();
  });
});
