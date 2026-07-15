import type { ILogger } from "@/commons";
import type { ResumeInput } from "@/nodes";
import type {
  AssistantWorkflowOutcome,
  ChatContent,
  InboundMessage,
} from "@/schemas";
import { inboundMessageSchema } from "@/schemas";
import type {
  IAuditService,
  IKafkaService,
  IProcessLogService,
  ResolveEnablement,
  RunnableGraph,
  RunWorkflow,
  Workflow,
} from "@/services";
import { enablementKeyOf, isAffirmative } from "@/services";
import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import {
  shouldPublishAssistantOutbound,
  type AssistantPublishPolicy,
} from "./cutover-policy";
import { defaultAnswerFor, outcomeToOutput } from "./outbound";
import {
  inboundAttachments,
  inboundText,
  type CorrelationStore,
} from "./shared";

export interface AssistantHandlerDeps {
  kafka: IKafkaService;
  logger: ILogger;
  audit: IAuditService;
  resolveEnablement: ResolveEnablement;
  runWorkflow: RunWorkflow;
  pausedWorkflow: (chatId: string) => Promise<Workflow | null>;
  /** The compiled assistant graph (thread_id `assistant:<chatId>`). */
  assistantGraph: RunnableGraph;
  correlations: CorrelationStore;
  publishPolicy?: AssistantPublishPolicy;
  processLog?: IProcessLogService;
}

/** Text of the last AI message in a graph result state. */
function lastAIText(state: unknown): string {
  const messages =
    (state as { messages?: unknown[] })?.messages ?? ([] as unknown[]);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      getType?: () => string;
      content?: unknown;
    };
    if (m?.getType?.() !== "ai") continue;
    const content = m.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: string }).type === "text",
        )
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    return "";
  }
  return "";
}

function documentsFor(
  outcome: AssistantWorkflowOutcome | null,
): ChatContent[] {
  if (!outcome) return [];
  if (outcome.kind === "result") return outcome.result.documents ?? [];
  if (outcome.kind === "approval" || outcome.kind === "clarification") {
    return outcome.documents ?? [];
  }
  return [];
}

/**
 * The hybrid-assistant inbound handler. A paused workflow is resumed first
 * (strict, deterministic); everything else flows through the conversational
 * assistant graph, which decides between answering directly and calling a
 * workflow tool. Never silent-drops: every inbound gets an outbound.
 */
export function createAssistantHandler(deps: AssistantHandlerDeps) {
  const {
    kafka,
    logger,
    audit,
    resolveEnablement,
    runWorkflow,
    pausedWorkflow,
    assistantGraph,
    correlations,
    publishPolicy = "always_publish",
    processLog,
  } = deps;

  async function publish(
    chatId: string,
    outcome: AssistantWorkflowOutcome | null,
    answer: string,
  ): Promise<void> {
    processLog?.log({
      event: "outbound.prepared",
      stage: "handler",
      status: outcome?.kind ?? "conversation",
      payload: { outcome, answer },
    });
    await kafka.publishOutbound({
      ...correlations.baseOutbound(chatId),
      content: [{ type: "text", text: answer }, ...documentsFor(outcome)],
      output: outcomeToOutput(outcome, answer),
    });
  }

  /** Phrase a turn through the assistant graph on its own checkpointed thread. */
  async function invokeAssistant(input: {
    chatId: string;
    tenantId: string;
    userId: string;
    humanText: string;
    attachments: { url: string; mimeType: string; fileName: string }[];
    enablement: { scheduling: boolean; invoicing: boolean; expense: boolean };
    workflowReport: AssistantWorkflowOutcome | null;
  }): Promise<{ outcome: AssistantWorkflowOutcome | null; answer: string }> {
    const runConfig = {
      configurable: { thread_id: `assistant:${input.chatId}` },
    };
    const started = Date.now();
    processLog?.log({
      event: "assistant.invoke",
      stage: "handler",
      status: "start",
      payload: {
        humanText: input.humanText,
        attachments: input.attachments,
        enablement: input.enablement,
        workflowReport: input.workflowReport,
      },
    });
    // Reset the checkpointed step budget each turn (stepCount is an
    // accumulator) — otherwise the max-steps cap builds up across turns and
    // eventually bricks the chat.
    const prior = (await assistantGraph.getState(runConfig)) as {
      values?: { stepCount?: number };
    };
    const priorSteps = prior?.values?.stepCount ?? 0;
    try {
      const state = (await assistantGraph.invoke(
        {
          messages: [new HumanMessage(input.humanText)],
          chatId: input.chatId,
          tenantId: input.tenantId,
          userId: input.userId,
          attachments: input.attachments,
          enablement: input.enablement,
          workflowReport: input.workflowReport,
          outcome: null,
          stepCount: -priorSteps,
        },
        runConfig,
      )) as { outcome?: AssistantWorkflowOutcome | null };
      const out = {
        outcome: state.outcome ?? null,
        answer: lastAIText(state),
      };
      processLog?.log({
        event: "assistant.invoke",
        stage: "handler",
        status: out.outcome?.kind ?? "conversation",
        durationMs: Date.now() - started,
        payload: out,
      });
      return out;
    } catch (error) {
      processLog?.log({
        event: "assistant.invoke",
        stage: "handler",
        status: "error",
        durationMs: Date.now() - started,
        error,
      });
      throw error;
    }
  }

  return async function handleInbound(raw: string): Promise<void> {
    const msg = inboundMessageSchema.parse(JSON.parse(raw));
    const chatId = msg.chatId;
    const text = inboundText(msg);
    correlations.remember(msg);

    await (processLog?.runWithContext(
      {
        traceId: msg.requestId,
        chatId,
        requestId: msg.requestId,
        tenantId: msg.tenantId,
        messageId: msg.messageId,
        userId: msg.createdBy,
        provider: msg.provider,
      },
      async () => {
        await handleInboundWithProcessLog(msg, chatId, text, raw);
      },
    ) ?? handleInboundWithProcessLog(msg, chatId, text, raw));
  };

  async function handleInboundWithProcessLog(
    msg: InboundMessage,
    chatId: string,
    text: string,
    raw: string,
  ): Promise<void> {
    try {
      const started = Date.now();
      const finish = (status: string, payload?: unknown) =>
        processLog?.log({
          event: "turn.finished",
          stage: "handler",
          status,
          durationMs: Date.now() - started,
          payload,
        });

      processLog?.log({
        event: "prompt.received",
        stage: "handler",
        payload: {
          raw,
          text,
          content: msg.content,
          chatType: msg.chatType,
          truncated: msg.truncated,
        },
      });
      // Per-tenant/per-member agent gate. Fail-closed (disabled on backend error).
      const enabled = await resolveEnablement({
        chatId,
        tenantId: msg.tenantId,
      });
      processLog?.log({
        event: "enablement.resolved",
        stage: "handler",
        payload: { enabled },
      });
      const enablement = {
        scheduling: enabled.scheduling,
        invoicing: enabled.invoicing,
        expense: enabled.expense,
      };

      // Resume a paused workflow if one is waiting on this chat — gated too, so
      // disabling an agent mid-conversation stops its paused thread.
      const paused = await pausedWorkflow(chatId);
      processLog?.log({
        event: "paused_workflow.detected",
        stage: "handler",
        status: paused ?? "none",
        payload: { workflow: paused },
      });
      if (paused) {
        if (!enabled[enablementKeyOf[paused]]) {
          const disabled: AssistantWorkflowOutcome = {
            kind: "agent_disabled",
            workflow: paused,
          };
          await publish(chatId, disabled, defaultAnswerFor(disabled));
          logger.info({ chatId, workflow: paused }, "agent disabled — gated");
          finish("agent_disabled", { workflow: paused });
          return;
        }
        const resume: ResumeInput = {
          reply: text,
          approved: isAffirmative(text),
        };
        processLog?.log({
          event: "workflow.resume",
          stage: "handler",
          workflow: paused,
          payload: { resume },
        });
        const outcome = (await runWorkflow(
          paused,
          chatId,
          new Command({ resume }),
        )) as AssistantWorkflowOutcome;

        // Paused again — relay the workflow's question/approval request verbatim
        // (exact approvalData contract, no rephrasing).
        if (outcome.kind !== "result") {
          await publish(chatId, outcome, defaultAnswerFor(outcome));
          finish(outcome.kind, { outcome });
          return;
        }

        // Finished — let the assistant phrase the structured result naturally,
        // which also lands both turns in its conversation memory.
        const { answer } = await invokeAssistant({
          chatId,
          tenantId: msg.tenantId ?? "",
          userId: msg.createdBy,
          humanText: text,
          attachments: [],
          enablement,
          workflowReport: outcome,
        });
        await publish(chatId, outcome, answer || defaultAnswerFor(outcome));
        audit.runFinished({
          threadId: chatId,
          status: outcome.result.status,
          durationMs: Date.now() - started,
        });
        finish(outcome.result.status, { outcome });
        return;
      }

      // Fresh message → the assistant decides: answer directly or call a workflow tool.
      const attachments = inboundAttachments(msg);
      const attachmentNote = attachments.length
        ? `\n[User attached: ${attachments.map((a) => a.fileName).join(", ")}]`
        : "";
      const { outcome, answer } = await invokeAssistant({
        chatId,
        tenantId: msg.tenantId ?? "",
        userId: msg.createdBy,
        humanText: `${text}${attachmentNote}`.trim() || "(empty message)",
        attachments,
        enablement,
        workflowReport: null,
      });
      const finalAnswer =
        answer ||
        (outcome
          ? defaultAnswerFor(outcome)
          : "Sorry, I could not produce a reply.");
      const published = shouldPublishAssistantOutbound(publishPolicy, outcome);
      if (published) {
        await publish(chatId, outcome, finalAnswer);
      } else {
        logger.info(
          { chatId, publishPolicy },
          "assistant pure conversation outbound suppressed",
        );
      }
      if (outcome?.kind === "result") {
        audit.runFinished({
          threadId: chatId,
          status: outcome.result.status,
          durationMs: Date.now() - started,
        });
      }
      finish(outcome?.kind ?? "conversation", { outcome, published });
    } catch (err) {
      processLog?.log({
        event: "turn.failed",
        stage: "handler",
        status: "error",
        error: err,
      });
      logger.error({ err, chatId }, "assistant handler failed");
      const answer = "Sorry, something went wrong while handling your message.";
      await kafka
        .publishOutbound({
          ...correlations.baseOutbound(chatId),
          content: [{ type: "text", text: answer }],
          output: { answer, intent: "not_supported" },
        })
        .catch((publishErr) =>
          logger.error({ err: publishErr, chatId }, "error reply failed"),
        );
    }
  }
}
