import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { ScheduleIntent } from '@/schemas';
import type { ILlmService } from '@/services';
import { createCalendarTool } from '@/tools';
import { buildScheduleGraph } from './schedule.graph';

function completeIntent(): ScheduleIntent {
  return {
    intent: 'schedule_meeting',
    attendee: 'Sarah',
    durationMinutes: 30,
    timezone: null,
    timeframe: 'next week',
    clarificationQuestion: null,
  };
}

function buildGraph() {
  const logger = pino({ level: 'silent' });
  const llmService: ILlmService = { extract: vi.fn().mockResolvedValue(completeIntent()) };
  return buildScheduleGraph(
    { llmService, calendarTool: createCalendarTool(logger), logger },
    new MemorySaver(),
  );
}

describe('schedule graph pause/resume', () => {
  it('pauses at the approval interrupt, then creates the event on approve', async () => {
    const graph = buildGraph();
    const config = { configurable: { thread_id: 'thread-approve' } };

    const paused: any = await graph.invoke(
      { threadId: 'thread-approve', userMessage: 'Schedule with Sarah next week' },
      config,
    );
    // Graph should be suspended awaiting approval.
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe('approval');

    const resumed: any = await graph.invoke(new Command({ resume: { approved: true } }), config);
    expect(resumed.result.status).toBe('created');
    expect(resumed.result.eventId).toBeTruthy();
  });

  it('cancels when the user declines approval', async () => {
    const graph = buildGraph();
    const config = { configurable: { thread_id: 'thread-decline' } };

    await graph.invoke(
      { threadId: 'thread-decline', userMessage: 'Schedule with Sarah next week' },
      config,
    );
    const resumed: any = await graph.invoke(new Command({ resume: { approved: false } }), config);
    expect(resumed.result.status).toBe('cancelled');
  });
});
