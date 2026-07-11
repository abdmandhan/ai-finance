import type { ILogger } from "@/commons";
import type { ResumeInput } from "@/nodes";
import { invoicePrompts } from "@/prompts";
import { inboundMessageSchema, workflowClassificationSchema } from "@/schemas";
import type {
  GraphResult,
  IAuditService,
  IKafkaService,
  ILlmService,
  ResolveEnablement,
  RunnableGraph,
  Workflow,
} from "@/services";
import {
  agentKeyOf,
  enablementKeyOf,
  extractInterrupt,
  isAffirmative,
  threadKey,
} from "@/services";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command } from "@langchain/langgraph";
import {
  inboundAttachments,
  inboundText,
  type CorrelationStore,
} from "./shared";

export interface LegacyHandlerDeps {
  kafka: IKafkaService;
  logger: ILogger;
  audit: IAuditService;
  llmService: ILlmService;
  resolveEnablement: ResolveEnablement;
  graphs: Record<Workflow, RunnableGraph>;
  pausedWorkflow: (chatId: string) => Promise<Workflow | null>;
  correlations: CorrelationStore;
}

/**
 * The pre-assistant inbound handler, kept verbatim behind the
 * `[assistant] enabled = false` rollback flag: LLM-classify each fresh message
 * into exactly one workflow; unsupported messages get no reply.
 * Delete once the assistant path has soaked.
 */
export function createLegacyHandler(deps: LegacyHandlerDeps) {
  const {
    kafka,
    logger,
    audit,
    llmService,
    resolveEnablement,
    graphs,
    pausedWorkflow,
    correlations,
  } = deps;

  /** Reply that a workflow's agent is disabled for this workspace, and don't run the graph. */
  async function publishDisabled(
    workflow: Workflow,
    chatId: string,
  ): Promise<void> {
    const label = workflow === "invoice" ? "Invoicing" : "Scheduling";
    const text = `The ${label} agent is currently disabled for your workspace.`;
    await kafka.publishOutbound({
      ...correlations.baseOutbound(chatId),
      content: [{ type: "text", text }],
      output: {
        answer: text,
        intent: "not_supported",
        agentKey: agentKeyOf[workflow],
      },
    });
    logger.info({ chatId, workflow }, "agent disabled — gated");
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
          ...correlations.baseOutbound(chatId),
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
          ...correlations.baseOutbound(chatId),
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
        ...correlations.baseOutbound(chatId),
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
      ...correlations.baseOutbound(chatId),
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

  return async function handleInbound(raw: string): Promise<void> {
    const msg = inboundMessageSchema.parse(JSON.parse(raw));
    const chatId = msg.chatId;
    const text = inboundText(msg);
    correlations.remember(msg);

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
        ...correlations.baseOutbound(chatId),
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
    const attachments = workflow === "invoice" ? inboundAttachments(msg) : [];
    await drive(workflow, chatId, {
      threadId: chatId,
      tenantId: msg.tenantId ?? "",
      userMessage: text,
      ...(attachments.length ? { attachments } : {}),
    });
  };
}
