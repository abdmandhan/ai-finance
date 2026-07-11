import { configUtils, loggerUtils } from "@/commons";
import { buildInvoiceGraph, buildScheduleGraph } from "@/graphs";
import { checkpointerUtils } from "@/memory";
import { type InterruptPayload, type ResumeInput } from "@/nodes";
import {
  inboundMessageSchema,
  workflowClassificationSchema,
  type OutboundMessage,
} from "@/schemas";
import { invoicePrompts } from "@/prompts";
import {
  createAuditService,
  createFetchAttachment,
  createKafkaService,
  createLlmService,
  createResolveAuth,
  createResolveEnablement,
  createResolveXeroAuth,
  type AgentEnablement,
} from "@/services";
import {
  createCalendarTool,
  createContactsTool,
  createMapsTool,
  createPreferencesTool,
  createXeroTool,
} from "@/tools";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";

type Workflow = "schedule" | "invoice";

/** Minimal graph surface the driver needs — avoids unioning the two giant compiled types. */
interface RunnableGraph {
  invoke(input: unknown, config: RunnableConfig): Promise<unknown>;
  getState(config: RunnableConfig): Promise<unknown>;
}

interface Correlation {
  requestId: string;
  messageId?: string;
  tenantId?: string;
  provider?: string;
}

/** Result shape produced by either graph's finalize node. */
interface GraphResult {
  status: string;
  summary: string;
  eventId?: string;
  htmlLink?: string;
  invoiceId?: string;
  suggestedSlots?: { start: string; end: string }[];
}

function extractInterrupt(result: unknown): InterruptPayload | null {
  const interrupts = (result as { __interrupt__?: Array<{ value?: unknown }> })
    ?.__interrupt__;
  return (interrupts?.[0]?.value as InterruptPayload | undefined) ?? null;
}

function isAffirmative(text: string): boolean {
  return /^\s*(yes|y|approve|approved|ok|okay|confirm|confirmed|sure|do it|go ahead)\b/i.test(
    text,
  );
}

/** Per-workflow thread namespace so the two graphs' checkpoints never collide on one chat. */
function threadKey(workflow: Workflow, chatId: string): string {
  return `${workflow}:${chatId}`;
}

async function main(): Promise<void> {
  const config = configUtils.initConfig();
  const logger = loggerUtils.createLogger(config.log);

  const kafka = createKafkaService(config, logger);
  const audit = createAuditService(logger);
  const llmService = createLlmService(config.llm);
  const resolveEnablement = createResolveEnablement(
    config.agents.enablement_endpoint_base_url,
    logger,
  );
  const checkpointer = checkpointerUtils.createCheckpointer(
    config.database.url,
    logger,
  );

  const onProgress = (
    chatId: string,
    event: Parameters<typeof kafka.publishEvent>[1],
  ) => {
    kafka
      .publishEvent(chatId, event)
      .catch((err) => logger.error({ err }, "publishEvent failed"));
  };

  const scheduleGraph = buildScheduleGraph(
    {
      llmService,
      calendarTool: createCalendarTool(logger),
      contactsTool: createContactsTool(logger),
      mapsTool: createMapsTool(config.calendar.maps_api_key, logger),
      resolveAuth: createResolveAuth(config.calendar.token_endpoint_base_url),
      defaultTimezone: config.calendar.default_timezone,
      schedulingPrefs: {
        bufferMinutes: config.calendar.buffer_minutes,
        workingHoursStart: config.calendar.working_hours_start,
        workingHoursEnd: config.calendar.working_hours_end,
      },
      preferencesTool: createPreferencesTool(config.database.url, logger),
      logger,
      onProgress,
    },
    checkpointer,
  );

  const invoiceGraph = buildInvoiceGraph(
    {
      llmService,
      xeroTool: createXeroTool(logger),
      resolveXeroAuth: createResolveXeroAuth(
        config.xero.token_endpoint_base_url,
      ),
      orgDefaults: {
        taxType: config.xero.default_tax_type,
        expenseAccountCode: config.xero.default_expense_account_code,
        revenueAccountCode: config.xero.default_revenue_account_code,
      },
      fetchAttachment: createFetchAttachment(),
      logger,
      onProgress,
    },
    checkpointer,
  );

  const graphs: Record<Workflow, RunnableGraph> = {
    schedule: scheduleGraph as unknown as RunnableGraph,
    invoice: invoiceGraph as unknown as RunnableGraph,
  };
  const agentKeyOf: Record<Workflow, string> = {
    schedule: "scheduling",
    invoice: "invoicing",
  };
  // Which enablement flag gates each workflow (the graph IS that agent).
  const enablementKeyOf: Record<Workflow, keyof AgentEnablement> = {
    schedule: "scheduling",
    invoice: "invoicing",
  };

  await kafka.connect();

  const correlations = new Map<string, Correlation>();
  function baseOutbound(chatId: string): OutboundMessage {
    const c = correlations.get(chatId);
    return {
      chatId,
      requestId: c?.requestId ?? chatId,
      messageId: c?.messageId,
      tenantId: c?.tenantId,
      provider: c?.provider,
    };
  }

  /** Reply that a workflow's agent is disabled for this workspace, and don't run the graph. */
  async function publishDisabled(
    workflow: Workflow,
    chatId: string,
  ): Promise<void> {
    const label = workflow === "invoice" ? "Invoicing" : "Scheduling";
    const text = `The ${label} agent is currently disabled for your workspace.`;
    await kafka.publishOutbound({
      ...baseOutbound(chatId),
      content: [{ type: "text", text }],
      output: {
        answer: text,
        intent: "not_supported",
        agentKey: agentKeyOf[workflow],
      },
    });
    logger.info({ chatId, workflow }, "agent disabled — gated");
  }

  /** Which workflow (if any) has a paused interrupt for this chat — i.e. this inbound is a resume. */
  async function pausedWorkflow(chatId: string): Promise<Workflow | null> {
    for (const wf of ["invoice", "schedule"] as Workflow[]) {
      const snapshot = await graphs[wf].getState({
        configurable: { thread_id: threadKey(wf, chatId) },
      });
      const tasks =
        (snapshot as { tasks?: Array<{ interrupts?: unknown[] }> }).tasks ?? [];
      const paused =
        tasks.some((t) => (t.interrupts?.length ?? 0) > 0) ||
        ((snapshot as { next?: unknown[] }).next?.length ?? 0) > 0;
      if (paused) return wf;
    }
    return null;
  }

  /** LLM router: pick the workflow for a fresh inbound message. */
  async function classify(
    text: string,
  ): Promise<"schedule" | "invoice" | "unsupported"> {
    try {
      const out = await llmService.extract(
        workflowClassificationSchema,
        [
          new SystemMessage(invoicePrompts.classifyPrompt()),
          new HumanMessage(text),
        ],
        "workflow",
      );
      return out.workflow;
    } catch (err) {
      logger.error({ err }, "classify failed");
      return "unsupported";
    }
  }

  /** Run/resume a graph, then publish the outbound reply / approval request. */
  async function drive(
    workflow: Workflow,
    chatId: string,
    input: unknown,
  ): Promise<void> {
    const runConfig: RunnableConfig = {
      configurable: { thread_id: threadKey(workflow, chatId) },
    };
    const started = Date.now();
    const agentKey = agentKeyOf[workflow];

    const raw = (await graphs[workflow].invoke(input, runConfig)) as {
      result?: GraphResult;
    };

    const pending = extractInterrupt(raw);
    if (pending) {
      if (pending.kind === "approval") {
        await kafka.publishOutbound({
          ...baseOutbound(chatId),
          content: [{ type: "text", text: pending.message }],
          output: {
            answer: pending.message,
            intent: "call_tool",
            agentKey,
            approvalData: [
              {
                ...pending.approval,
                items: pending.approval.items.map((i) => ({
                  ...i,
                  status: "pending" as const,
                })),
              },
            ],
          },
        });
      } else {
        await kafka.publishOutbound({
          ...baseOutbound(chatId),
          content: [{ type: "text", text: pending.message }],
          output: {
            answer: pending.message,
            intent: "needs_clarification",
            agentKey,
          },
        });
      }
      return;
    }

    const result = raw.result ?? {
      status: "failed",
      summary: "No result produced.",
    };

    // Schedule conflict → propose alternatives.
    if (result.status === "proposed") {
      const slots = result.suggestedSlots ?? [];
      const list = slots.length
        ? "\nSome open times:\n" + slots.map((s) => `- ${s.start}`).join("\n")
        : "";
      const answer = `${result.summary}${list}`;
      await kafka.publishOutbound({
        ...baseOutbound(chatId),
        content: [{ type: "text", text: answer }],
        output: { answer, intent: "needs_clarification", agentKey },
      });
      audit.runFinished({
        threadId: chatId,
        status: "proposed",
        durationMs: Date.now() - started,
      });
      return;
    }

    const created = result.status === "created";
    // Informational reply (schedule lookup) — nothing created, no approvalData.
    const answered = result.status === "answered";
    const answer =
      created && result.htmlLink
        ? `${result.summary}\n${result.htmlLink}`
        : result.summary;
    // Post-hoc approvalData record for a completed action (calendar event or authorised invoice).
    const ref = result.eventId ?? result.invoiceId;
    const approvalData =
      created && ref
        ? [
            {
              name:
                workflow === "invoice"
                  ? "xero_authorise_invoice"
                  : "create_calendar_event",
              provider: workflow === "invoice" ? "xero" : "calendar",
              items: [
                { ref, label: result.summary, status: "completed" as const },
              ],
            },
          ]
        : undefined;

    await kafka.publishOutbound({
      ...baseOutbound(chatId),
      content: [{ type: "text", text: answer }],
      output: {
        answer,
        intent: created ? "call_tool" : answered ? "ok" : "not_supported",
        agentKey,
        ...(approvalData ? { approvalData } : {}),
      },
    });
    audit.runFinished({
      threadId: chatId,
      status: result.status,
      durationMs: Date.now() - started,
    });
  }

  await kafka.consume(config.kafka.topics.inbound, async (raw) => {
    const msg = inboundMessageSchema.parse(JSON.parse(raw));
    const chatId = msg.chatId;
    const text = msg.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text as string)
      .join("\n")
      .trim();

    correlations.set(chatId, {
      requestId: msg.requestId,
      messageId: msg.messageId,
      tenantId: msg.tenantId,
      provider: msg.provider,
    });

    // Per-tenant/per-member agent gate. Fail-closed (disabled on backend error). Resolved once
    // here (cached) and reused for both the resume and fresh-goal paths.
    const enabled = await resolveEnablement({ chatId, tenantId: msg.tenantId });

    // Resume a paused workflow if one is waiting on this chat — gated too, so disabling an agent
    // mid-conversation stops its paused thread.
    const paused = await pausedWorkflow(chatId);
    if (paused) {
      if (!enabled[enablementKeyOf[paused]]) {
        await publishDisabled(paused, chatId);
        return;
      }
      const resume: ResumeInput = {
        reply: text,
        approved: isAffirmative(text),
      };
      await drive(paused, chatId, new Command({ resume }));
      return;
    }

    // No agent enabled at all → don't even classify (mirrors the Agent's before_agent_reply gate).
    if (!enabled.scheduling && !enabled.invoicing) {
      const text2 = "AI agents are currently disabled for your workspace.";
      await kafka.publishOutbound({
        ...baseOutbound(chatId),
        content: [{ type: "text", text: text2 }],
        output: { answer: text2, intent: "not_supported" },
      });
      logger.info({ chatId }, "all agents disabled — gated");
      return;
    }

    // Otherwise route a fresh message to a workflow, then gate on that workflow's agent.
    const workflow = await classify(text);
    if (workflow === "unsupported") {
      logger.info({ chatId }, "unsupported request — no reply");
      return;
    }
    if (!enabled[enablementKeyOf[workflow]]) {
      await publishDisabled(workflow, chatId);
      return;
    }
    audit.runStarted({ threadId: chatId, workflow, userId: msg.createdBy });
    // Invoicing can read + attach files (photo/document) carried on the message.
    const attachments =
      workflow === "invoice"
        ? msg.content
            .filter(
              (c) => (c.type === "photo" || c.type === "document") && c.url,
            )
            .map((c) => ({
              url: c.url as string,
              mimeType: c.mimeType ?? "application/octet-stream",
              fileName: c.fileName ?? "attachment",
            }))
        : [];
    await drive(workflow, chatId, {
      threadId: chatId,
      tenantId: msg.tenantId ?? "",
      userId: msg.createdBy ?? "",
      userMessage: text,
      ...(attachments.length ? { attachments } : {}),
    });
  });

  logger.info("Tigeri graph service running");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await kafka.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
