import type { Config, ILogger } from "@/commons";
import { Redis } from "ioredis";

export interface ICacheService {
  client(): Redis;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  /** SET NX (+EX when ttl given). Returns true when the key was newly set. */
  setIfNotExist(key: string, value: string, ttl?: number): Promise<boolean>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  ping(): Promise<string>;
  disconnect(): Promise<void>;
}

export class RedisCacheService implements ICacheService {
  private readonly redisClient: Redis;

  constructor(
    config: Config,
    private readonly logger: ILogger,
  ) {
    const opts: { password?: string } = {};
    if (config.redis.password) {
      opts.password = config.redis.password;
    }
    this.redisClient = new Redis(config.redis.url, opts);
    this.redisClient.on("error", (err) =>
      this.logger.error({ err }, "redis error"),
    );
  }

  client(): Redis {
    return this.redisClient;
  }

  async get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl !== undefined) {
      await this.redisClient.set(key, value, "EX", ttl);
    } else {
      await this.redisClient.set(key, value);
    }
  }

  async setIfNotExist(
    key: string,
    value: string,
    ttl?: number,
  ): Promise<boolean> {
    if (ttl !== undefined) {
      const result = await this.redisClient.set(key, value, "EX", ttl, "NX");
      return result === "OK";
    }

    const result = await this.redisClient.set(key, value, "NX");
    return result === "OK";
  }

  async del(key: string): Promise<void> {
    await this.redisClient.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.redisClient.exists(key);
    return result === 1;
  }

  async ping(): Promise<string> {
    return this.redisClient.ping();
  }

  async disconnect(): Promise<void> {
    await this.redisClient.quit();
  }
}

export function createCacheService(
  config: Config,
  logger: ILogger,
): ICacheService {
  if (!config.redis.url) {
    throw new Error("redis.url is required for the cache service");
  }
  return new RedisCacheService(config, logger);
}
