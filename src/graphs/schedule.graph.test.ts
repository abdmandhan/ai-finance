import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { ScheduleIntent } from '@/schemas';
import type { CalendarAuth, ILlmService } from '@/services';
import { StubCalendarTool, StubContactsTool, type Contact } from '@/tools';
import type { ScheduleDeps } from '@/nodes';
import { buildScheduleGraph } from './schedule.graph';

function intent(over: Partial<ScheduleIntent> = {}): ScheduleIntent {
  return {
    intent: 'schedule_meeting',
    attendee: 'Sarah',
    attendeeEmail: null,
    durationMinutes: 30,
    timezone: null,
    timeframe: 'next week',
    clarificationQuestion: null,
    ...over,
  };
}

const fakeAuth: CalendarAuth = {
  accessToken: 'x',
  provider: 'google',
  calendarId: 'primary',
  emailAddress: 'me@example.com',
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

function buildGraph(opts: { intents?: ScheduleIntent[]; contacts?: Contact[] } = {}) {
  const logger = pino({ level: 'silent' });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { extract };
  const contactsTool = new StubContactsTool(opts.contacts ?? []);
  const deps: ScheduleDeps = {
    llmService,
    calendarTool: new StubCalendarTool(logger),
    contactsTool,
    resolveAuth: async () => fakeAuth,
    logger,
  };
  return { graph: buildScheduleGraph(deps, new MemorySaver()), contactsTool };
}

describe('schedule graph (no approval, contacts-aware)', () => {
  it('creates immediately when the contact is known — no pause', async () => {
    const { graph } = buildGraph({ contacts: [{ name: 'Sarah', email: 'sarah@example.com' }] });
    const config = { configurable: { thread_id: 't-known' } };

    const result: any = await graph.invoke(
      { threadId: 't-known', tenantId: 'tenant-1', userMessage: 'Schedule 30 min with Sarah next week' },
      config,
    );

    expect(result.__interrupt__).toBeUndefined();
    expect(result.result.status).toBe('created');
    expect(result.result.eventId).toBeTruthy();
    expect(result.attendeeEmail).toBe('sarah@example.com');
  });

  it('asks for the email when unknown, then saves the contact and creates', async () => {
    const { graph, contactsTool } = buildGraph({
      // First parse: no email. Second parse (after reply): email present.
      intents: [intent(), intent({ attendeeEmail: 'sarah@new.com' })],
      contacts: [],
    });
    const config = { configurable: { thread_id: 't-unknown' } };

    const paused: any = await graph.invoke(
      { threadId: 't-unknown', tenantId: 'tenant-1', userMessage: 'Schedule 30 min with Sarah next week' },
      config,
    );
    expect(paused.__interrupt__?.[0]?.value?.kind).toBe('clarification');

    const resumed: any = await graph.invoke(new Command({ resume: { reply: 'sarah@new.com' } }), config);
    expect(resumed.result.status).toBe('created');

    // New contact was saved to the (stub) book.
    const found = await contactsTool.lookup(fakeAuth, 'Sarah');
    expect(found[0]?.email).toBe('sarah@new.com');
  });
});
