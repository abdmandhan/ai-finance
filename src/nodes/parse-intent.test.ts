import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { ScheduleIntent } from '@/schemas';
import type { ILlmService } from '@/services';
import { makeParseIntentNode } from './parse-intent';
import { NODES, type ScheduleDeps } from './shared';

function buildDeps(over: Partial<ScheduleIntent>): ScheduleDeps {
  const intent: ScheduleIntent = {
    intent: 'schedule_meeting',
    attendee: null,
    attendeeEmail: null,
    durationMinutes: null,
    timezone: null,
    timeframe: null,
    clarificationQuestion: null,
    ...over,
  };
  return {
    llmService: { extract: vi.fn().mockResolvedValue(intent) } as ILlmService,
    calendarTool: {} as ScheduleDeps['calendarTool'],
    contactsTool: {} as ScheduleDeps['contactsTool'],
    resolveAuth: (async () => ({}) as never) as ScheduleDeps['resolveAuth'],
    logger: pino({ level: 'silent' }),
  };
}

const baseState = { threadId: 't1', userMessage: 'hi', clarifyAttempts: 0 } as any;

describe('parse-intent node', () => {
  it('routes to resolve_contact when attendee and timeframe are present', async () => {
    const node = makeParseIntentNode(buildDeps({ attendee: 'Sarah', timeframe: 'next week' }));
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.resolveContact);
    expect(out.durationMinutes).toBe(30); // default applied
    expect(out.attendee).toBe('Sarah');
  });

  it('extracts attendeeEmail when explicitly present', async () => {
    const node = makeParseIntentNode(
      buildDeps({ attendee: 'Sarah', timeframe: 'next week', attendeeEmail: 'sarah@x.com' }),
    );
    const out = await node.node(baseState);
    expect(out.attendeeEmail).toBe('sarah@x.com');
    expect(out._nextNode).toBe(NODES.resolveContact);
  });

  it('routes to clarification when required info is missing', async () => {
    const node = makeParseIntentNode(
      buildDeps({ clarificationQuestion: 'Who should I meet with and when?' }),
    );
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.askClarification);
  });

  it('fails cleanly for unsupported requests', async () => {
    const node = makeParseIntentNode(buildDeps({ intent: 'unsupported' }));
    const out = await node.node(baseState);
    expect(out._nextNode).toBe(NODES.finalize);
    expect(out.result?.status).toBe('failed');
  });

  it('gives up after max clarify attempts instead of looping', async () => {
    const node = makeParseIntentNode(buildDeps({ clarificationQuestion: 'Who and when?' }));
    const out = await node.node({ ...baseState, clarifyAttempts: 2 });
    expect(out._nextNode).toBe(NODES.finalize);
    expect(out.result?.status).toBe('failed');
  });
});
