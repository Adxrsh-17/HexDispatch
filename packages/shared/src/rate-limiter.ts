import type Redis from 'ioredis';

export interface RateLimitOptions {
  windowSec: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfterSec: number;
  limit: number;
}

export class RateLimiter {
  private inMemoryMap = new Map<string, { count: number; resetAt: number }>();

  constructor(private redis?: Redis) {}

  async check(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
    const { windowSec, maxRequests } = options;

    if (this.redis && this.redis.status === 'ready') {
      try {
        const fullKey = `ratelimit:${key}`;
        // Atomic increment and TTL setup
        const lua = `
          local current = redis.call('INCR', KEYS[1])
          if current == 1 then
            redis.call('EXPIRE', KEYS[1], ARGV[1])
          end
          local ttl = redis.call('TTL', KEYS[1])
          return { current, ttl }
        `;
        const res = (await this.redis.eval(lua, 1, fullKey, windowSec)) as [number, number];
        const count = res[0];
        const ttl = res[1] > 0 ? res[1] : windowSec;

        const allowed = count <= maxRequests;
        return {
          allowed,
          remaining: Math.max(0, maxRequests - count),
          resetAfterSec: ttl,
          limit: maxRequests,
        };
      } catch {
        // Fall back to in-memory on redis error
      }
    }

    // In-memory fallback
    const now = Date.now();
    const entry = this.inMemoryMap.get(key);
    if (!entry || entry.resetAt <= now) {
      this.inMemoryMap.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return {
        allowed: true,
        remaining: maxRequests - 1,
        resetAfterSec: windowSec,
        limit: maxRequests,
      };
    }

    entry.count += 1;
    const allowed = entry.count <= maxRequests;
    const resetAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return {
      allowed,
      remaining: Math.max(0, maxRequests - entry.count),
      resetAfterSec,
      limit: maxRequests,
    };
  }
}

