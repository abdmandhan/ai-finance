import type { ILogger } from "@/commons";
import type { ResumeInput } from "@/nodes";
import type { AssistantWorkflowOutcome } from "@/schemas";
import { inboundMessageSchema } from "@/schemas";
import type {
  IAuditService,
  IKafkaService,
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
  } = deps;

  async function publish(
    chatId: string,
    outcome: AssistantWorkflowOutcome | null,
    answer: string,
  ): Promise<void> {
    await kafka.publishOutbound({
      ...correlations.baseOutbound(chatId),
      content: [{ type: "text", text: answer }],
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
    // Reset the checkpointed step budget each turn (stepCount is an
    // accumulator) — otherwise the max-steps cap builds up across turns and
    // eventually bricks the chat.
    const prior = (await assistantGraph.getState(runConfig)) as {
      values?: { stepCount?: number };
    };
    const priorSteps = prior?.values?.stepCount ?? 0;
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
    return {
      outcome: state.outcome ?? null,
      answer: lastAIText(state),
    };
  }

  return async function handleInbound(raw: string): Promise<void> {
    const msg = inboundMessageSchema.parse(JSON.parse(raw));
    const chatId = msg.chatId;
    const text = inboundText(msg);
    correlations.remember(msg);

    try {
      const started = Date.now();
      // Per-tenant/per-member agent gate. Fail-closed (disabled on backend error).
      const enabled = await resolveEnablement({
        chatId,
        tenantId: msg.tenantId,
      });
      const enablement = {
        scheduling: enabled.scheduling,
        invoicing: enabled.invoicing,
        expense: enabled.expense,
      };

      // Resume a paused workflow if one is waiting on this chat — gated too, so
      // disabling an agent mid-conversation stops its paused thread.
      const paused = await pausedWorkflow(chatId);
      if (paused) {
        if (!enabled[enablementKeyOf[paused]]) {
          const disabled: AssistantWorkflowOutcome = {
            kind: "agent_disabled",
            workflow: paused,
          };
          await publish(chatId, disabled, defaultAnswerFor(disabled));
          logger.info({ chatId, workflow: paused }, "agent disabled — gated");
          return;
        }
        const resume: ResumeInput = {
          reply: text,
          approved: isAffirmative(text),
        };
        const outcome = (await runWorkflow(
          paused,
          chatId,
          new Command({ resume }),
        )) as AssistantWorkflowOutcome;

        // Paused again — relay the workflow's question/approval request verbatim
        // (exact approvalData contract, no rephrasing).
        if (outcome.kind !== "result") {
          await publish(chatId, outcome, defaultAnswerFor(outcome));
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
      if (shouldPublishAssistantOutbound(publishPolicy, outcome)) {
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
    } catch (err) {
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
  };
}
