import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { ScheduleIntent } from '@/schemas';
import type { ILlmService } from '@/services';
import type { ICalendarTool } from '@/tools';
import { makeParseIntentNode } from './parse-intent';
import { NODES } from './shared';

function buildDeps(intent: ScheduleIntent) {
  const llmService: ILlmService = {
    extract: vi.fn().mockResolvedValue(intent),
  };
  const calendarTool = {} as ICalendarTool;
  return { llmService, calendarTool, logger: pino({ level: 'silent' }) };
}

const baseState = {
  threadId: 't1',
  userMessage: 'hi',
  clarifyAttempts: 0,
} as any;

describe('parse-intent node', () => {
  it('routes to search when attendee and timeframe are present', async () => {
    const node = makeParseIntentNode(
      buildDeps({
        intent: 'schedule_meeting',
        attendee: 'Sarah',
        durationMinutes: null,
        timezone: null,
        timeframe: 'next week',
        clarificationQuestion: null,
      }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.searchCalendar);
    expect(out.durationMinutes).toBe(30); // default applied
    expect(out.attendee).toBe('Sarah');
  });

  it('routes to clarification when required info is missing', async () => {
    const node = makeParseIntentNode(
      buildDeps({
        intent: 'schedule_meeting',
        attendee: null,
        durationMinutes: null,
        timezone: null,
        timeframe: null,
        clarificationQuestion: 'Who should I meet with and when?',
      }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.askClarification);
  });

  it('fails cleanly for unsupported requests', async () => {
    const node = makeParseIntentNode(
      buildDeps({
        intent: 'unsupported',
        attendee: null,
        durationMinutes: null,
        timezone: null,
        timeframe: null,
        clarificationQuestion: null,
      }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.finalize);
    expect(out.result?.status).toBe('failed');
  });

  it('gives up after max clarify attempts instead of looping', async () => {
    const node = makeParseIntentNode(
      buildDeps({
        intent: 'schedule_meeting',
        attendee: null,
        durationMinutes: null,
        timezone: null,
        timeframe: null,
        clarificationQuestion: 'Who and when?',
      }),
    );
    const out = await node.node({ ...baseState, clarifyAttempts: 2 });
    expect(out._nextNode).toBe(NODES.finalize);
    expect(out.result?.status).toBe('failed');
  });
});
