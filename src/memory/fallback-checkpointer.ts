import type { ILogger } from "@/commons";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RedisSaver } from "@langchain/langgraph-checkpoint-redis";

export interface IFallbackCheckpointer extends BaseCheckpointSaver {
  flushToPostgres(threadIds?: string[]): Promise<void>;
  setup(): Promise<void>;
}

/**
 * Redis-first checkpointer (hot, TTL-bound) with Postgres as durable fallback.
 * Reads hydrate Redis from Postgres on a miss; writes mark the thread dirty so
 * `flushToPostgres()` (called on shutdown) persists anything Redis-only.
 */
export class FallbackCheckpointer
  extends BaseCheckpointSaver
  implements IFallbackCheckpointer
{
  private readonly dirtyThreads = new Set<string>();

  constructor(
    private readonly redisSaver: RedisSaver,
    private readonly postgresSaver: PostgresSaver,
    private readonly logger: ILogger,
  ) {
    super();
    this.logger = logger.child({ name: "FallbackCheckpointer" });
  }

  /** Idempotent DDL for the Postgres tier (RedisSaver needs no setup). */
  async setup(): Promise<void> {
    await this.postgresSaver.setup();
  }

  private extractThreadId(config: RunnableConfig): string | undefined {
    return config.configurable?.thread_id as string | undefined;
  }

  private markDirty(config: RunnableConfig): void {
    const threadId = this.extractThreadId(config);
    if (threadId) {
      this.dirtyThreads.add(threadId);
    }
  }

  /** Group pendingWrites by taskId and call putFn for each group. */
  private async putGroupedWrites(
    tuple: CheckpointTuple,
    putFn: (writes: PendingWrite[], taskId: string) => Promise<void>,
  ): Promise<void> {
    if (!tuple.pendingWrites?.length) return;

    const byTaskId = new Map<string, PendingWrite[]>();
    for (const [taskId, channel, value] of tuple.pendingWrites) {
      const group = byTaskId.get(taskId) ?? [];
      group.push([channel, value]);
      byTaskId.set(taskId, group);
    }

    const tasks: Promise<void>[] = [];
    for (const [taskId, writes] of byTaskId) {
      tasks.push(putFn(writes, taskId));
    }
    await Promise.all(tasks);
  }

  override async getTuple(
    config: RunnableConfig,
  ): Promise<CheckpointTuple | undefined> {
    // Try Redis first
    try {
      const tuple = await this.redisSaver.getTuple(config);
      if (tuple) {
        return tuple;
      }
    } catch (err) {
      this.logger.warn(
        { err, threadId: this.extractThreadId(config) },
        "Redis getTuple failed, falling back to Postgres",
      );
    }

    // Fallback to Postgres
    try {
      const tuple = await this.postgresSaver.getTuple(config);
      if (tuple) {
        // Hydrate Redis with Postgres data (fire-and-forget)
        const emptyMetadata: CheckpointMetadata = {
          source: "input" as const,
          step: 0,
          parents: {},
        };
        this.redisSaver
          .put(
            tuple.config,
            tuple.checkpoint,
            tuple.metadata ?? emptyMetadata,
            tuple.checkpoint.channel_versions ?? {},
          )
          .catch((err) => {
            this.logger.warn({ err }, "Failed to hydrate Redis from Postgres");
          });
        this.putGroupedWrites(tuple, (writes, taskId) =>
          this.redisSaver
            .putWrites(tuple.config, writes, taskId)
            .catch((err) => {
              this.logger.warn(
                { err, taskId },
                "Failed to hydrate writes to Redis",
              );
            }),
        );
      }
      return tuple;
    } catch (err) {
      this.logger.warn(
        { err, threadId: this.extractThreadId(config) },
        "Postgres getTuple also failed",
      );
      return undefined;
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    this.markDirty(config);

    // Try Redis first
    try {
      const result = await this.redisSaver.put(
        config,
        checkpoint,
        metadata,
        newVersions,
      );
      return result;
    } catch (err) {
      this.logger.warn(
        { err, threadId: this.extractThreadId(config) },
        "Redis put failed, falling back to Postgres",
      );
    }

    // Fallback to Postgres
    const result = await this.postgresSaver.put(
      config,
      checkpoint,
      metadata,
      newVersions,
    );
    return result;
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.markDirty(config);

    // Try Redis first
    try {
      await this.redisSaver.putWrites(config, writes, taskId);
      return;
    } catch (err) {
      this.logger.warn(
        { err, threadId: this.extractThreadId(config) },
        "Redis putWrites failed, falling back to Postgres",
      );
    }

    // Fallback to Postgres
    await this.postgresSaver.putWrites(config, writes, taskId);
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const saverOptions = options as
      (CheckpointListOptions & { filter?: CheckpointMetadata }) | undefined;
    // Try Redis first
    try {
      let hasResults = false;
      for await (const tuple of this.redisSaver.list(config, saverOptions)) {
        hasResults = true;
        yield tuple;
      }
      if (hasResults) return;
    } catch (err) {
      this.logger.warn({ err }, "Redis list failed, falling back to Postgres");
    }

    // Fallback to Postgres
    try {
      for await (const tuple of this.postgresSaver.list(config, saverOptions)) {
        yield tuple;
      }
    } catch (err) {
      this.logger.warn({ err }, "Postgres list also failed");
    }
  }

  override async deleteThread(threadId: string): Promise<void> {
    this.dirtyThreads.delete(threadId);

    // Delete from both (best effort)
    try {
      await this.redisSaver.deleteThread(threadId);
    } catch (err) {
      this.logger.warn({ err, threadId }, "Redis deleteThread failed");
    }

    try {
      await this.postgresSaver.deleteThread(threadId);
    } catch (err) {
      this.logger.warn({ err, threadId }, "Postgres deleteThread failed");
    }
  }

  /**
   * Flush dirty Redis checkpoints to Postgres.
   * Called during shutdown to ensure no state is lost.
   */
  async flushToPostgres(threadIds?: string[]): Promise<void> {
    const ids = threadIds ?? [...this.dirtyThreads];
    if (ids.length === 0) {
      this.logger.info("No dirty threads to flush");
      return;
    }

    this.logger.info(
      { count: ids.length },
      "Flushing dirty checkpoints to Postgres",
    );

    for (const threadId of ids) {
      try {
        const config: RunnableConfig = {
          configurable: { thread_id: threadId },
        };
        const tuple = await this.redisSaver.getTuple(config);
        if (tuple) {
          const emptyMetadata: CheckpointMetadata = {
            source: "input" as const,
            step: 0,
            parents: {},
          };
          await this.postgresSaver.put(
            tuple.config,
            tuple.checkpoint,
            tuple.metadata ?? emptyMetadata,
            tuple.checkpoint.channel_versions ?? {},
          );
          await this.putGroupedWrites(tuple, (writes, taskId) =>
            this.postgresSaver.putWrites(tuple.config, writes, taskId),
          );
          this.dirtyThreads.delete(threadId);
        }
      } catch (err) {
        this.logger.error(
          { err, threadId },
          "Failed to flush checkpoint to Postgres",
        );
      }
    }

    this.dirtyThreads.clear();
    this.logger.info("Flush complete");
  }
}
