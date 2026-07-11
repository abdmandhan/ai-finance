import type { Config, ILogger } from "@/commons";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { FallbackCheckpointer } from "./fallback-checkpointer";

/**
 * Build the durable checkpointer used to persist graph state across the
 * clarification / approval interrupts.
 *
 * - no database.url             → MemorySaver (dev only — lost on restart)
 * - database.url only           → PostgresSaver
 * - database.url + redis.url    → FallbackCheckpointer (Redis hot tier,
 *                                  Postgres durable fallback + shutdown flush)
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

  // RedisSaver.fromUrl connects eagerly — only reach here with a redis.url.
  const url = config.redis.password
    ? `redis://:${config.redis.password}@${new URL(config.redis.url).host}`
    : config.redis.url;
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
};
