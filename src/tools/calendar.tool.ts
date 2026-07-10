import type { ILogger } from '@/commons';
import type { Slot } from '@/schemas';

/**
 * Calendar tool contract. Tools only perform side effects — no planning logic.
 * This is a STUB with mock data; swap the implementation for Google Calendar
 * without changing the graph (idempotent create keyed by the caller's context).
 */
export interface ICalendarTool {
  searchAvailability(params: {
    attendee: string;
    durationMinutes: number;
    timeframe: string;
  }): Promise<Slot[]>;

  createEvent(params: {
    attendee: string;
    slot: Slot;
    summary: string;
  }): Promise<{ eventId: string }>;
}

export class StubCalendarTool implements ICalendarTool {
  constructor(private readonly logger: ILogger) {}

  async searchAvailability(params: {
    attendee: string;
    durationMinutes: number;
    timeframe: string;
  }): Promise<Slot[]> {
    this.logger.info({ params }, 'calendar.searchAvailability (stub)');
    // Deterministic mock: three slots on the next business day at 09:00 / 11:00 / 14:00 UTC.
    const base = new Date();
    base.setUTCDate(base.getUTCDate() + 1);
    base.setUTCHours(0, 0, 0, 0);
    const hours = [9, 11, 14];
    return hours.map((h) => {
      const start = new Date(base);
      start.setUTCHours(h);
      const end = new Date(start.getTime() + params.durationMinutes * 60_000);
      return { start: start.toISOString(), end: end.toISOString() };
    });
  }

  async createEvent(params: {
    attendee: string;
    slot: Slot;
    summary: string;
  }): Promise<{ eventId: string }> {
    this.logger.info({ params }, 'calendar.createEvent (stub)');
    // Deterministic id derived from inputs so retries are idempotent.
    const eventId = `evt_${Buffer.from(`${params.attendee}:${params.slot.start}`).toString('base64url')}`;
    return { eventId };
  }
}

export function createCalendarTool(logger: ILogger): ICalendarTool {
  return new StubCalendarTool(logger);
}
