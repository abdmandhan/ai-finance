import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { ScheduleIntent } from '@/schemas';
import type { CalendarAuth, ILlmService } from '@/services';
import { StubCalendarTool, StubContactsTool, StubMapsTool, type CalendarEvent, type Contact } from '@/tools';
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
    requestedStartIso: null,
    location: null,
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

function buildGraph(
  opts: {
    intents?: ScheduleIntent[];
    contacts?: Contact[];
    events?: CalendarEvent[];
    travelMinutes?: number;
  } = {},
) {
  const logger = pino({ level: 'silent' });
  const extract = vi.fn();
  for (const i of opts.intents ?? [intent()]) extract.mockResolvedValueOnce(i);
  const llmService: ILlmService = { extract };
  const contactsTool = new StubContactsTool(opts.contacts ?? []);
  const deps: ScheduleDeps = {
    llmService,
    calendarTool: new StubCalendarTool(logger, opts.events ?? []),
    contactsTool,
    mapsTool: new StubMapsTool(opts.travelMinutes ?? 10),
    resolveAuth: async () => fakeAuth,
    defaultTimezone: 'UTC',
    schedulingPrefs: { bufferMinutes: 15, workingHoursStart: 9, workingHoursEnd: 18 },
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

describe('schedule graph honors the requested date/time', () => {
  const knownSarah = [{ name: 'Sarah', email: 'sarah@example.com' }];

  it('books the exact requested time (not a default hour, not shifted)', async () => {
    // "tomorrow morning at 10" resolved to Sat 12 Jul 10:00 by the parser.
    const requested = '2026-07-12T10:00:00.000Z';
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: requested, timeframe: null, durationMinutes: 30 })],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: 't-exact' } };

    const result: any = await graph.invoke(
      { threadId: 't-exact', tenantId: 'tenant-1', userMessage: 'schedule a call with Sarah tomorrow morning at 10' },
      config,
    );

    expect(result.result.status).toBe('created');
    expect(result.selectedSlot.start).toBe(requested);
    // Regression guards for the reported bug:
    expect(result.selectedSlot.start).not.toContain('T09:00'); // not snapped to 09:00
    expect(result.selectedSlot.start.startsWith('2026-07-12')).toBe(true); // not shifted to Mon 13
  });

  it('does not skip a weekend when a weekend day is explicitly requested', async () => {
    const saturday = '2026-07-12T10:00:00.000Z'; // 2026-07-12 is a Saturday
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: saturday, timeframe: null })],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: 't-weekend' } };

    const result: any = await graph.invoke(
      { threadId: 't-weekend', tenantId: 'tenant-1', userMessage: 'meet Sarah Saturday at 10' },
      config,
    );
    expect(result.selectedSlot.start).toBe(saturday);
  });

  it('sets the end to start + duration', async () => {
    const requested = '2026-07-12T10:00:00.000Z';
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: requested, timeframe: null, durationMinutes: 45 })],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: 't-dur' } };

    const result: any = await graph.invoke(
      { threadId: 't-dur', tenantId: 'tenant-1', userMessage: 'meet Sarah tomorrow at 10 for 45 min' },
      config,
    );
    expect(result.selectedSlot.end).toBe('2026-07-12T10:45:00.000Z');
  });

  it('falls back to the working-hours scan for vague requests', async () => {
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: null, timeframe: 'next week' })],
      contacts: knownSarah,
    });
    const config = { configurable: { thread_id: 't-vague' } };

    const result: any = await graph.invoke(
      { threadId: 't-vague', tenantId: 'tenant-1', userMessage: 'schedule with Sarah sometime next week' },
      config,
    );
    expect(result.result.status).toBe('created');
    expect(result.selectedSlot.start).toBeTruthy();
  });
});

describe('schedule graph — conflicts and travel time', () => {
  const knownSarah = [{ name: 'Sarah', email: 'sarah@example.com' }];

  it('proposes alternatives (does not book) when the requested time overlaps an event', async () => {
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: '2026-07-13T10:30:00.000Z', timeframe: null })],
      contacts: knownSarah,
      events: [
        { eventId: 'e1', summary: 'Standup', start: '2026-07-13T10:00:00.000Z', end: '2026-07-13T11:00:00.000Z' },
      ],
    });
    const config = { configurable: { thread_id: 't-overlap' } };

    const result: any = await graph.invoke(
      { threadId: 't-overlap', tenantId: 'tenant-1', userMessage: 'meet Sarah Monday 10:30' },
      config,
    );
    expect(result.result.status).toBe('proposed');
    expect(result.result.suggestedSlots.length).toBeGreaterThan(0);
    expect(result.result.eventId).toBeUndefined();
  });

  it('proposes alternatives when there is not enough travel time from the prior meeting', async () => {
    const { graph } = buildGraph({
      // Requested 10:00 at a far location; prior in-person event ends 09:45 (15 min gap).
      intents: [intent({ requestedStartIso: '2026-07-13T10:00:00.000Z', timeframe: null, location: 'Airport, far away' })],
      contacts: knownSarah,
      events: [
        {
          eventId: 'e1',
          summary: 'Client visit',
          start: '2026-07-13T09:00:00.000Z',
          end: '2026-07-13T09:45:00.000Z',
          location: '10 Downing St',
        },
      ],
      travelMinutes: 40, // 40 > 15 min gap → too tight
    });
    const config = { configurable: { thread_id: 't-travel' } };

    const result: any = await graph.invoke(
      { threadId: 't-travel', tenantId: 'tenant-1', userMessage: 'meet Sarah Monday 10 at the airport' },
      config,
    );
    expect(result.result.status).toBe('proposed');
    expect(result.result.summary.toLowerCase()).toContain('travel');
  });

  it('books when there is enough travel time and no conflict', async () => {
    const { graph } = buildGraph({
      intents: [intent({ requestedStartIso: '2026-07-13T10:30:00.000Z', timeframe: null, location: 'Airport, far away' })],
      contacts: knownSarah,
      events: [
        {
          eventId: 'e1',
          summary: 'Client visit',
          start: '2026-07-13T09:00:00.000Z',
          end: '2026-07-13T09:45:00.000Z',
          location: '10 Downing St',
        },
      ],
      travelMinutes: 5, // 5 min travel, 45 min gap → fine
    });
    const config = { configurable: { thread_id: 't-ok' } };

    const result: any = await graph.invoke(
      { threadId: 't-ok', tenantId: 'tenant-1', userMessage: 'meet Sarah Monday 10:30 at the airport' },
      config,
    );
    expect(result.result.status).toBe('created');
    expect(result.selectedSlot.start).toBe('2026-07-13T10:30:00.000Z');
  });
});
