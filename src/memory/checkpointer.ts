import type { ILogger } from '@/commons';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/**
 * Build the durable checkpointer used to persist graph state across the
 * clarification / approval interrupts. Falls back to an in-memory saver when
 * no Postgres url is configured (dev only — state is lost on restart).
 */
function createCheckpointer(databaseUrl: string, logger: ILogger): BaseCheckpointSaver {
  if (!databaseUrl) {
    logger.warn('No database.url configured — using in-memory checkpointer (no durability)');
    return new MemorySaver();
  }
  logger.info('Using Postgres checkpointer');
  return PostgresSaver.fromConnString(databaseUrl);
}

/**
 * Idempotently create the checkpointer tables. Run once before first use
 * (via `pnpm setup:db`). No-op for the in-memory saver.
 */
async function setupCheckpointer(checkpointer: BaseCheckpointSaver): Promise<void> {
  if (checkpointer instanceof PostgresSaver) {
    await checkpointer.setup();
  }
}

export const checkpointerUtils = {
  createCheckpointer,
  setupCheckpointer,
};
