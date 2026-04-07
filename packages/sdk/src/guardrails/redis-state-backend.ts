// ---------------------------------------------------------------------------
// RedisStateBackend — cross-instance workflow call counter backed by Redis.
// Accepts any Redis-compatible client (ioredis, @upstash/redis, node-redis, etc.)
// via MinimalRedisClient. Keys are prefixed "lr:wfg:" to avoid collisions.
// Fails open on Redis errors — availability is preserved over strict enforcement.
// ---------------------------------------------------------------------------

import type { StateBackend } from "./state-backend";

/**
 * Minimal Redis interface — satisfied by ioredis, @upstash/redis, node-redis v4+.
 * The SDK does not depend on any specific Redis client library.
 */
export interface MinimalRedisClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number | unknown>;
}

const KEY_PREFIX = "lr:wfg:";

export class RedisStateBackend implements StateBackend {
  constructor(private readonly redis: MinimalRedisClient) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    const redisKey = KEY_PREFIX + key;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      // First write — set TTL so idle workflows are automatically evicted.
      await this.redis.expire(redisKey, Math.ceil(ttlMs / 1000));
    }
    return count;
  }

  async get(key: string): Promise<number> {
    const val = await this.redis.get(KEY_PREFIX + key);
    return val !== null ? parseInt(val, 10) : 0;
  }

  async evict(key: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + key);
  }

  // Redis client lifecycle is managed by the caller — nothing to do here.
  async shutdown(): Promise<void> {}
}
