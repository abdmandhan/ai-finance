import { configUtils, loggerUtils } from '@/commons';
import { buildScheduleGraph, type ScheduleGraph } from '@/graphs';
import { checkpointerUtils } from '@/memory';
import { type InterruptPayload, type ResumeInput } from '@/nodes';
import { inboundMessageSchema, type OutboundMessage } from '@/schemas';
import { createAuditService, createKafkaService, createLlmService, createResolveAuth } from '@/services';
import { createCalendarTool, createContactsTool, createMapsTool } from '@/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Command } from '@langchain/langgraph';

/** Correlation fields echoed from the inbound message onto every outbound reply. */
interface Correlation {
  requestId: string;
  messageId?: string;
  tenantId?: string;
  provider?: string;
}

/** Pull the pending interrupt payload (if any) off an invoke result. */
function extractInterrupt(result: unknown): InterruptPayload | null {
  const interrupts = (result as { __interrupt__?: Array<{ value?: unknown }> })?.__interrupt__;
  return (interrupts?.[0]?.value as InterruptPayload | undefined) ?? null;
}

async function main(): Promise<void> {
  const config = configUtils.initConfig();
  const logger = loggerUtils.createLogger(config.log);

  const kafka = createKafkaService(config, logger);
  const audit = createAuditService(logger);
  const checkpointer = checkpointerUtils.createCheckpointer(config.database.url, logger);

  const graph: ScheduleGraph = buildScheduleGraph(
    {
      llmService: createLlmService(config.llm),
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
      logger,
      onProgress: (chatId, event) => {
        kafka.publishEvent(chatId, event).catch((err) => logger.error({ err }, 'publishEvent failed'));
      },
    },
    checkpointer,
  );

  await kafka.connect();

  // chatId -> correlation, refreshed on every inbound so outbound replies echo the source.
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

  /** Is the thread currently paused on an interrupt (i.e. this inbound is a resume)? */
  async function isPaused(runConfig: RunnableConfig): Promise<boolean> {
    const snapshot = await graph.getState(runConfig);
    const tasks = (snapshot as { tasks?: Array<{ interrupts?: unknown[] }> }).tasks ?? [];
    if (tasks.some((t) => (t.interrupts?.length ?? 0) > 0)) return true;
    return ((snapshot as { next?: unknown[] }).next?.length ?? 0) > 0;
  }

  /** Run a fresh goal or resume a paused thread, then emit the outbound reply/approval. */
  async function drive(
    chatId: string,
    input: Parameters<ScheduleGraph['invoke']>[0],
  ): Promise<void> {
    const runConfig: RunnableConfig = { configurable: { thread_id: chatId } };
    const started = Date.now();

    const result = (await graph.invoke(input, runConfig)) as {
      result?: {
        status: string;
        summary: string;
        eventId?: string;
        htmlLink?: string;
        suggestedSlots?: { start: string; end: string }[];
      };
      intent?: string;
      attendee?: string;
    };

    // The only interrupt left is a clarification (e.g. asking for a missing email).
    const pending = extractInterrupt(result);
    if (pending) {
      logger.info({ chatId }, 'graph paused — awaiting user clarification');
      await kafka.publishOutbound({
        ...baseOutbound(chatId),
        content: [{ type: 'text', text: pending.message }],
        output: { answer: pending.message, intent: 'needs_clarification', agentKey: 'scheduling' },
      });
      return;
    }

    const finalResult = result.result ?? { status: 'failed', summary: 'No result produced.' };

    // Conflict / insufficient travel — propose alternatives, do NOT book.
    if (finalResult.status === 'proposed') {
      const slots = finalResult.suggestedSlots ?? [];
      const list = slots.length
        ? '\nSome open times:\n' + slots.map((s) => `- ${s.start}`).join('\n')
        : '';
      const answer = `${finalResult.summary}${list}`;
      await kafka.publishOutbound({
        ...baseOutbound(chatId),
        content: [{ type: 'text', text: answer }],
        output: { answer, intent: 'needs_clarification', agentKey: 'scheduling' },
      });
      audit.runFinished({ threadId: chatId, status: 'proposed', durationMs: Date.now() - started });
      return;
    }

    // Always reply. On success, attach a post-hoc approvalData record (status 'completed') —
    // the event is already created; this is a backend log, not a gate.
    const created = finalResult.status === 'created';
    const answer = created && finalResult.htmlLink
      ? `${finalResult.summary}\n${finalResult.htmlLink}`
      : finalResult.summary;
    const intent =
      result.intent === 'unsupported' ? 'not_supported' : created ? 'schedule_meeting' : 'not_supported';

    await kafka.publishOutbound({
      ...baseOutbound(chatId),
      content: [{ type: 'text', text: answer }],
      output: {
        answer,
        intent,
        agentKey: 'scheduling',
        ...(created && finalResult.eventId
          ? {
              approvalData: [
                {
                  name: 'create_calendar_event',
                  provider: 'calendar',
                  items: [
                    {
                      ref: finalResult.eventId,
                      label: `Meeting with ${result.attendee ?? 'attendee'}`,
                      status: 'completed' as const,
                    },
                  ],
                },
              ],
            }
          : {}),
      },
    });
    audit.runFinished({ threadId: chatId, status: finalResult.status, durationMs: Date.now() - started });
  }

  // Single inbound topic carries both new goals and resume replies (keyed by chatId).
  await kafka.consume(config.kafka.topics.inbound, async (raw) => {
    const msg = inboundMessageSchema.parse(JSON.parse(raw));
    const chatId = msg.chatId;
    const text = msg.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text as string)
      .join('\n')
      .trim();

    correlations.set(chatId, {
      requestId: msg.requestId,
      messageId: msg.messageId,
      tenantId: msg.tenantId,
      provider: msg.provider,
    });

    const runConfig: RunnableConfig = { configurable: { thread_id: chatId } };
    if (await isPaused(runConfig)) {
      const resume: ResumeInput = { reply: text };
      await drive(chatId, new Command({ resume }));
    } else {
      audit.runStarted({ threadId: chatId, workflow: 'schedule', userId: msg.createdBy });
      await drive(chatId, { threadId: chatId, tenantId: msg.tenantId ?? '', userMessage: text });
    }
  });

  logger.info('Tigeri graph service running');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await kafka.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
