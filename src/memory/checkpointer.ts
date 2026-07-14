import type { Config, ILogger } from "@/commons";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { Redis } from "ioredis";
import { FallbackCheckpointer } from "./fallback-checkpointer";

/**
 * RedisSaver needs RedisJSON + RediSearch (Redis Stack or Redis 8+).
 * Plain Redis lacks JSON.SET / FT.CREATE and would spam fallback warnings.
 */
async function redisSupportsCheckpointModules(url: string): Promise<boolean> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    lazyConnect: true,
  });
  try {
    await client.connect();
    // Prefer MODULE LIST when available (Redis Stack / Redis with modules).
    try {
      const modules = (await client.call("MODULE", "LIST")) as unknown;
      if (Array.isArray(modules) && modules.length > 0) {
        const names = new Set<string>();
        for (const entry of modules) {
          if (!Array.isArray(entry)) continue;
          for (let i = 0; i < entry.length - 1; i++) {
            if (String(entry[i]).toLowerCase() === "name") {
              names.add(String(entry[i + 1]).toLowerCase());
            }
          }
        }
        const hasJson =
          names.has("rejson") || names.has("redisjson") || names.has("json");
        const hasSearch =
          names.has("search") ||
          names.has("redisearch") ||
          names.has("ft") ||
          names.has("bf.search");
        if (hasJson && hasSearch) return true;
      }
    } catch {
      // MODULE LIST missing (older Redis) — fall through to command probes.
    }

    // Command probes: succeed only when both modules respond.
    const probeKey = `__graph_ckpt_probe:${process.pid}`;
    try {
      await client.call("JSON.SET", probeKey, "$", "{}");
      await client.call("JSON.DEL", probeKey);
    } catch {
      return false;
    }
    try {
      await client.call("FT._LIST");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Unknown index / empty list is fine — unknown command is not.
      if (/unknown command/i.test(msg)) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

function resolveRedisUrl(config: Config): string {
  return config.redis.password
    ? `redis://:${config.redis.password}@${new URL(config.redis.url).host}`
    : config.redis.url;
}

/**
 * Build the durable checkpointer used to persist graph state across the
 * clarification / approval interrupts.
 *
 * - no database.url             → MemorySaver (dev only — lost on restart)
 * - database.url only           → PostgresSaver
 * - database.url + redis.url    → FallbackCheckpointer when Redis has
 *                                  RedisJSON+RediSearch; else PostgresSaver
 *                                  (plain Redis stays available for queue/cache)
 */
async function createCheckpointer(
  config: Config,
  logger: ILogger,
): Promise<BaseCheckpointSaver> {
  if (!config.database.url) {
    logger.warn(
      "No database.url configured — using in-memory checkpointer (no durability)",
    );
    return new MemorySaver();
  }

  const postgresSaver = PostgresSaver.fromConnString(config.database.url);
  if (!config.redis.url) {
    logger.info("Using Postgres checkpointer");
    return postgresSaver;
  }

  const url = resolveRedisUrl(config);
  const modulesOk = await redisSupportsCheckpointModules(url);
  if (!modulesOk) {
    logger.warn(
      "Redis lacks RedisJSON/RediSearch — using Postgres checkpointer only (queue/cache still use redis.url)",
    );
    return postgresSaver;
  }

  const redisSaver = await RedisSaver.fromUrl(url, {
    defaultTTL: 1_440, // 24h (unit is minutes, lib multiplies by 60)
    refreshOnRead: true,
  });
  logger.info("Using Redis+Postgres fallback checkpointer");
  return new FallbackCheckpointer(redisSaver, postgresSaver, logger);
}

/**
 * Idempotently create the checkpointer tables. Run once before first use
 * (via `pnpm setup:db`). No-op for the in-memory saver.
 */
async function setupCheckpointer(
  checkpointer: BaseCheckpointSaver,
): Promise<void> {
  if (checkpointer instanceof FallbackCheckpointer) {
    await checkpointer.setup();
  } else if (checkpointer instanceof PostgresSaver) {
    await checkpointer.setup();
  }
}

export const checkpointerUtils = {
  createCheckpointer,
  setupCheckpointer,
  /** @internal exported for unit tests */
  redisSupportsCheckpointModules,
};
