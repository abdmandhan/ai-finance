import type { ILogger } from "@/commons";

/**
 * Resolves per-chat / per-tenant agent enablement from the App backend so the graph engine can
 * gate a disabled agent before running its workflow. Ported from the openclaw Agent's
 * `extensions/agent-gating/src/enablement-client.ts`; the fetch shape follows `google-auth.ts`:
 *   GET {base}/api/v1/internal/agents/enablement?chatId=<id>    (inbound: resolves tenant + member)
 *   GET {base}/api/v1/internal/agents/enablement?tenantId=<id>  (fallback: tenant-wide pause only)
 *   -> { agents: { expense, invoicing, scheduling: boolean } }
 *
 * Cached per key with a short TTL to avoid a backend round-trip on every inbound message. On a
 * backend error we serve the last good value if we have one, otherwise fail closed (all disabled)
 * so a paused agent never runs during an outage.
 */

export type AgentEnablement = {
  expense: boolean;
  invoicing: boolean;
  scheduling: boolean;
};

const ALL_DISABLED: AgentEnablement = {
  expense: false,
  invoicing: false,
  scheduling: false,
};

// Short TTL: a pause/resume takes effect within this window. Kept under a minute so a paused
// agent stops promptly.
const TTL_MS = 45_000;

/** Resolve enablement for a chat (preferred) or tenant. Never throws — callers always get a value. */
export type ResolveEnablement = (key: {
  chatId?: string;
  tenantId?: string;
}) => Promise<AgentEnablement>;

type CacheEntry = { value: AgentEnablement; expiresAtMs: number };

/** Coerce the backend `{ agents: {...} }` envelope into a strict boolean triple. */
function normalize(raw: unknown): AgentEnablement {
  const agents =
    raw && typeof raw === "object" && "agents" in raw
      ? (raw as { agents?: Record<string, unknown> }).agents
      : undefined;
  return {
    expense: agents?.expense === true,
    invoicing: agents?.invoicing === true,
    scheduling: agents?.scheduling === true,
  };
}

export function createResolveEnablement(
  baseUrl: string,
  logger: ILogger,
): ResolveEnablement {
  const base = baseUrl.replace(/\/+$/, "");
  const cache = new Map<string, CacheEntry>();

  return async function resolveEnablement(key): Promise<AgentEnablement> {
    // Prefer chatId (resolves tenant + member); fall back to tenant-wide pause only.
    const cacheKey = key.chatId
      ? `chat:${key.chatId}`
      : key.tenantId
        ? `tenant:${key.tenantId}`
        : "";
    if (!cacheKey) return ALL_DISABLED;

    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAtMs > now) return cached.value;

    const query = key.chatId
      ? `chatId=${encodeURIComponent(key.chatId)}`
      : `tenantId=${encodeURIComponent(key.tenantId as string)}`;
    try {
      const res = await fetch(
        `${base}/api/v1/internal/agents/enablement?${query}`,
      );
      if (!res.ok) throw new Error(`enablement endpoint ${res.status}`);
      const value = normalize(await res.json());
      cache.set(cacheKey, { value, expiresAtMs: now + TTL_MS });
      return value;
    } catch (err) {
      // Serve the last good value if we have one (even if expired); otherwise fail closed. Don't
      // cache the failure, so the next message retries the backend.
      logger.warn(
        { err, cacheKey },
        "agent enablement fetch failed — serving stale/fail-closed",
      );
      return cached?.value ?? ALL_DISABLED;
    }
  };
}
