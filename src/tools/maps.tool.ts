/**
 * Google Maps travel-time — ported from Agent's `extensions/scheduling/src/maps-client.ts`.
 * Distance Matrix API, authed by a query-param `key` (NOT the OAuth token). When no key is
 * configured the tool returns null (feature off → callers fall back to buffer-only).
 */
import type { ILogger } from '@/commons';

export type TravelMode = 'driving' | 'transit' | 'walking';

export interface TravelTimeResult {
  durationMinutes: number;
  distanceKm: number;
  mode: TravelMode;
  origin: string;
  destination: string;
}

export interface IMapsTool {
  travelTime(origin: string, destination: string, mode?: TravelMode): Promise<TravelTimeResult | null>;
}

const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

export class GoogleMapsTool implements IMapsTool {
  constructor(
    private readonly apiKey: string,
    private readonly logger: ILogger,
  ) {}

  async travelTime(
    origin: string,
    destination: string,
    mode: TravelMode = 'driving',
  ): Promise<TravelTimeResult | null> {
    if (!this.apiKey) return null;

    const url = new URL(DISTANCE_MATRIX_URL);
    url.searchParams.set('origins', origin);
    url.searchParams.set('destinations', destination);
    url.searchParams.set('mode', mode);
    url.searchParams.set('units', 'metric');
    url.searchParams.set('key', this.apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Maps Distance Matrix ${res.status}: ${await res.text()}`);

    const data = (await res.json()) as {
      status: string;
      rows?: { elements?: { status: string; duration?: { value: number }; distance?: { value: number } }[] }[];
    };
    if (data.status !== 'OK') throw new Error(`Maps Distance Matrix error: ${data.status}`);

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') return null;

    return {
      durationMinutes: Math.ceil((element.duration?.value ?? 0) / 60),
      distanceKm: Math.round(((element.distance?.value ?? 0) / 1000) * 10) / 10,
      mode,
      origin,
      destination,
    };
  }
}

/** Offline stub — fixed travel minutes for tests/Studio. */
export class StubMapsTool implements IMapsTool {
  constructor(private readonly durationMinutes = 10) {}
  async travelTime(origin: string, destination: string, mode: TravelMode = 'driving') {
    return { durationMinutes: this.durationMinutes, distanceKm: 5, mode, origin, destination };
  }
}

/** No key → a tool that always returns null (travel checks skipped, buffer-only). */
export class NoopMapsTool implements IMapsTool {
  async travelTime(): Promise<TravelTimeResult | null> {
    return null;
  }
}

export function createMapsTool(apiKey: string | undefined, logger: ILogger): IMapsTool {
  const key = apiKey?.trim() || process.env.OPENCLAW_MAPS_API_KEY?.trim();
  if (!key) {
    logger.info('Maps API key not set — travel-time checks disabled (buffer-only)');
    return new NoopMapsTool();
  }
  return new GoogleMapsTool(key, logger);
}
