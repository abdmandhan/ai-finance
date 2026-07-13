/**
 * Live-LLM eval harness: real model (from config.toml [llm]), StubXeroTool for
 * all Xero I/O, MemorySaver checkpointing — the full stack minus Kafka/Postgres.
 * Assertions run against the stub's recorded operations and the interrupts the
 * graphs raise, keyed to the catalogue in XERO-TEST-CASE-PLAN.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import { configUtils, loggerUtils, type Config } from "@/commons";
import {
  buildAssistantGraph,
  buildExpenseGraph,
  buildInvoiceGraph,
  buildPaymentGraph,
  buildReportGraph,
} from "@/graphs";
import { baseSeed, fakeXeroAuth } from "@/graphs/xero.test-utils";
import type { InterruptPayload } from "@/nodes";
import { createLlmService, type ILlmService } from "@/services";
import {
  createWorkflowRunner,
  type RunnableGraph,
  type Workflow,
} from "@/services/workflow-runner";
import { StubXeroTool, type StubXeroSeed } from "@/tools";
import type { EvalCase, StubOpKind } from "./cases/types";

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

let config: Config | null = null;
let llmService: ILlmService | null = null;

function initOnce() {
  if (config) return;
  config = configUtils.initConfig();
  const logger = loggerUtils.createLogger({ ...config.log, level: "error" });
  llmService = createLlmService(config.llm, logger);
}

/** True when config.toml provides a usable model (api key or a local base url). */
export function hasLlmConfigured(): boolean {
  try {
    initOnce();
  } catch {
    return false;
  }
  const llm = config!.llm as unknown as Record<string, unknown>;
  const keys: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      if ((k === "api_key" || k === "url") && typeof val === "string" && val)
        keys.push(val);
      walk(val);
    }
  };
  walk(llm);
  return keys.length > 0;
}

export function fixturePath(name: string): string {
  return resolve(FIXTURES_DIR, name);
}

export function fixtureExists(name: string): boolean {
  return existsSync(fixturePath(name));
}

export interface EvalEnv {
  stub: StubXeroTool;
  workflowGraph: (wf: Exclude<Workflow, "schedule">) => RunnableGraph;
  assistant: RunnableGraph;
}

export function buildEvalEnv(seed?: StubXeroSeed): EvalEnv {
  initOnce();
  const logger = loggerUtils.createLogger({ ...config!.log, level: "error" });
  const stub = new StubXeroTool(seed ?? baseSeed());
  const resolveXeroAuth = async () => fakeXeroAuth;
  const orgDefaults = { taxType: "", expenseAccountCode: "", revenueAccountCode: "" };
  // Reads fixture files from evals/fixtures/ — the attachment "url" is the fixture name.
  const fetchAttachment = async (url: string, mimeType?: string) => {
    const bytes = new Uint8Array(readFileSync(fixturePath(url)));
    const contentType = mimeType ?? "application/octet-stream";
    return {
      bytes,
      contentType,
      dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  };

  const invoice = buildInvoiceGraph(
    { llmService: llmService!, xeroTool: stub, resolveXeroAuth, orgDefaults, fetchAttachment, logger },
    new MemorySaver(),
  );
  const payment = buildPaymentGraph(
    { llmService: llmService!, xeroTool: stub, resolveXeroAuth, logger },
    new MemorySaver(),
  );
  const expense = buildExpenseGraph(
    { llmService: llmService!, xeroTool: stub, resolveXeroAuth, orgDefaults, fetchAttachment, logger },
    new MemorySaver(),
  );
  const report = buildReportGraph(
    { llmService: llmService!, xeroTool: stub, resolveXeroAuth, logger },
    new MemorySaver(),
  );
  const stubSchedule: RunnableGraph = {
    invoke: async () => ({
      result: { status: "created", summary: "(stub) scheduled" },
    }),
    getState: async () => ({ tasks: [], next: [] }),
  };

  const graphs: Record<Workflow, RunnableGraph> = {
    schedule: stubSchedule,
    invoice: invoice as unknown as RunnableGraph,
    payment: payment as unknown as RunnableGraph,
    expense: expense as unknown as RunnableGraph,
    report: report as unknown as RunnableGraph,
  };
  const runWorkflow = createWorkflowRunner({ graphs, logger });
  const assistant = buildAssistantGraph(
    {
      llmService: llmService!,
      runWorkflow,
      audit: {
        runStarted: () => {},
        toolCalled: () => {},
        runFinished: () => {},
      },
      defaultTimezone: "Asia/Singapore",
      maxHistoryMessages: 30,
      logger,
    },
    new MemorySaver(),
  ) as unknown as RunnableGraph;

  return {
    stub,
    workflowGraph: (wf) => graphs[wf],
    assistant,
  };
}

export interface RunResult {
  stub: StubXeroTool;
  /** Every interrupt raised across the initial invoke + steps, in order. */
  interrupts: InterruptPayload[];
  /** The interrupt still PENDING after the final invoke/resume — null when the run finished. */
  pending: InterruptPayload | null;
  /** The workflow's final `result` (workflow level) or assistant `outcome.result`. */
  result?: { status?: string; summary?: string } & Record<string, unknown>;
  /** Final user-facing text: pending interrupt message, result summary, or assistant reply. */
  finalText: string;
}

export async function runCase(env: EvalEnv, c: EvalCase): Promise<RunResult> {
  const attachments = (c.attachments ?? []).map((a) => ({
    url: a.fixture,
    mimeType: a.mimeType,
    fileName: a.fileName,
  }));

  if (c.level === "workflow") {
    const graph = env.workflowGraph(c.workflow!);
    const cfg = { configurable: { thread_id: `eval:${c.id}` } };
    const interrupts: InterruptPayload[] = [];
    const pull = (raw: unknown): InterruptPayload | null =>
      ((raw as { __interrupt__?: { value?: InterruptPayload }[] })
        .__interrupt__?.[0]?.value ?? null);

    let raw: any = await graph.invoke(
      {
        threadId: `eval:${c.id}`,
        tenantId: "t1",
        userMessage: c.prompt,
        ...(attachments.length ? { attachments } : {}),
      },
      cfg,
    );
    let pending = pull(raw);
    if (pending) interrupts.push(pending);

    for (const step of c.steps ?? []) {
      raw = await graph.invoke(new Command({ resume: step.resume }), cfg);
      pending = pull(raw);
      if (pending) interrupts.push(pending);
    }

    const finalText = pending?.message ?? raw.result?.summary ?? "";
    return { stub: env.stub, interrupts, pending, result: raw.result, finalText };
  }

  // assistant level: one turn through the conversational graph.
  const cfg = { configurable: { thread_id: `eval:${c.id}` } };
  const raw: any = await env.assistant.invoke(
    {
      messages: [{ role: "user", content: c.prompt }],
      chatId: `eval:${c.id}`,
      tenantId: "t1",
      userId: "u1",
      attachments,
      enablement: { scheduling: true, invoicing: true, expense: true },
      workflowReport: null,
      outcome: null,
    },
    cfg,
  );
  const outcome = raw.outcome ?? null;
  const interrupts: InterruptPayload[] = [];
  if (outcome?.kind === "clarification")
    interrupts.push({ kind: "clarification", message: outcome.question });
  if (outcome?.kind === "approval")
    interrupts.push({
      kind: "approval",
      message: outcome.message,
      approval: outcome.approval,
    });
  return {
    stub: env.stub,
    interrupts,
    pending: interrupts.at(-1) ?? null,
    result: outcome?.kind === "result" ? outcome.result : undefined,
    finalText: String(raw.messages?.at(-1)?.content ?? ""),
  };
}

function textMatches(text: string, want: string | RegExp): boolean {
  return typeof want === "string"
    ? text.toLowerCase().includes(want.toLowerCase())
    : want.test(text);
}

/** Assert a finished RunResult against the case's expectations. */
export function assertCase(res: RunResult, c: EvalCase): void {
  const e = c.expect;
  const last = res.pending;

  if (e.interrupt === "none") {
    expect(last, `expected no pending interrupt, got ${JSON.stringify(last)}`).toBeNull();
  } else if (e.interrupt) {
    expect(last?.kind, `expected a pending ${e.interrupt}`).toBe(e.interrupt);
    if (e.interruptMessage)
      expect(
        textMatches(last?.message ?? "", e.interruptMessage),
        `interrupt message "${last?.message}" !~ ${e.interruptMessage}`,
      ).toBe(true);
  }

  for (const [kind, spec] of Object.entries(e.ops ?? {})) {
    const records = res.stub[kind as StubOpKind] as unknown[];
    if (spec.count !== undefined)
      expect(records, `ops.${kind} count`).toHaveLength(spec.count);
    else expect(records.length, `ops.${kind} non-empty`).toBeGreaterThan(0);
    if (spec.match) expect(records[0]).toMatchObject(spec.match);
  }

  for (const kind of e.mustNotOps ?? []) {
    expect(res.stub[kind], `mustNot ops.${kind}`).toHaveLength(0);
  }

  if (e.resultStatus) expect(res.result?.status).toBe(e.resultStatus);

  for (const want of e.answerIncludes ?? []) {
    expect(
      textMatches(res.finalText, want),
      `final text "${res.finalText}" missing ${want}`,
    ).toBe(true);
  }
  for (const not of e.answerExcludes ?? []) {
    expect(
      textMatches(res.finalText, not),
      `final text "${res.finalText}" must not contain ${not}`,
    ).toBe(false);
  }
}
