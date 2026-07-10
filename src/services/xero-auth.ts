/**
 * Per-tenant Xero auth, ported from Agent's `extensions/xero/src/xero-client.ts`.
 * This service holds no Xero OAuth — it fetches a fresh access token from the backend:
 *   GET {tokenBase}/api/v1/internal/xero/access?tenantId=<id>
 *   -> { accessToken, xeroTenantId, apiBaseUrl, expiresAt }
 * The `xeroTenantId` (the `xero-tenant-id` header) is returned by the backend, not sent.
 */

export interface XeroAuth {
  accessToken: string;
  xeroTenantId: string;
  apiBaseUrl: string;
  expiresAtMs: number;
}

export type ResolveXeroAuth = (tenantId: string) => Promise<XeroAuth>;

const tokenCache = new Map<string, XeroAuth>();

export function createResolveXeroAuth(tokenBaseUrl: string): ResolveXeroAuth {
  const base = tokenBaseUrl.replace(/\/+$/, "");

  return async function resolveXeroAuth(tenantId: string): Promise<XeroAuth> {
    const now = Date.now();
    const cached = tokenCache.get(tenantId);
    if (cached && cached.expiresAtMs - 60_000 > now) {
      return cached;
    }

    const url = `${base}/api/v1/internal/xero/access?tenantId=${encodeURIComponent(tenantId)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `xero token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      accessToken?: string;
      xeroTenantId?: string;
      apiBaseUrl?: string;
      expiresAt?: string;
    };
    if (!data.accessToken || !data.xeroTenantId) {
      throw new Error(
        "xero token endpoint returned incomplete auth (need accessToken + xeroTenantId)",
      );
    }

    const auth: XeroAuth = {
      accessToken: data.accessToken,
      xeroTenantId: data.xeroTenantId,
      apiBaseUrl: (
        data.apiBaseUrl || "https://api.xero.com/api.xro/2.0"
      ).replace(/\/+$/, ""),
      expiresAtMs: data.expiresAt
        ? Date.parse(data.expiresAt)
        : now + 25 * 60_000,
    };
    tokenCache.set(tenantId, auth);
    return auth;
  };
}
