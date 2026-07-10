/**
 * Per-tenant Google auth, ported from Agent's `extensions/scheduling/src/calendar-client.ts`.
 * This service holds no OAuth secrets — it fetches a fresh short-lived access token from the
 * backend token endpoint. The same token is reused for Calendar and Drive (contacts), so the
 * backend grant must include `calendar` + `drive.file` scopes.
 */

export interface CalendarAuth {
  accessToken: string;
  provider: 'google' | 'microsoft';
  calendarId: string;
  emailAddress: string;
  expiresAtMs: number;
}

/** Resolves a per-tenant CalendarAuth. Injected into the graph so tests/Studio can fake it. */
export type ResolveAuth = (tenantId: string) => Promise<CalendarAuth>;

const tokenCache = new Map<string, CalendarAuth>();

export function createResolveAuth(tokenBaseUrl: string): ResolveAuth {
  const base = tokenBaseUrl.replace(/\/+$/, '');

  return async function resolveAuth(tenantId: string): Promise<CalendarAuth> {
    const now = Date.now();
    const cached = tokenCache.get(tenantId);
    if (cached && cached.expiresAtMs - 60_000 > now) {
      return cached;
    }

    const url = `${base}/api/v1/internal/calendar/access?tenantId=${encodeURIComponent(tenantId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      accessToken?: string;
      provider?: string;
      calendarId?: string;
      emailAddress?: string;
      expiresAt?: string;
    };
    if (!data.accessToken) {
      throw new Error('token endpoint returned incomplete auth (need accessToken)');
    }

    const auth: CalendarAuth = {
      accessToken: data.accessToken,
      provider: data.provider === 'microsoft' ? 'microsoft' : 'google',
      calendarId: data.calendarId || 'primary',
      emailAddress: data.emailAddress || tenantId,
      expiresAtMs: data.expiresAt ? Date.parse(data.expiresAt) : now + 25 * 60_000,
    };
    tokenCache.set(tenantId, auth);
    return auth;
  };
}
