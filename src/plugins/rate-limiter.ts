import { FastifyRequest, FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { Config } from '../config';
import { ErrorSanitizerService } from '../services/error-sanitizer.service';

export class GatewayRateLimiter {
  private redisClient: Redis | null = null;
  // In-memory sliding window bucket: key -> Array of timestamps
  private memoryBuckets = new Map<string, number[]>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private config: Config) {
    if (config.REDIS_URL) {
      try {
        const client = new Redis(config.REDIS_URL, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1
        });
        client.connect().then(() => {
          this.redisClient = client;
          console.log('[RateLimiter] Connected to Redis for distributed rate limiting');
        }).catch(() => {
          console.warn('[RateLimiter] Redis connection failed, using in-memory rate limiter');
          this.redisClient = null;
        });
      } catch {
        this.redisClient = null;
      }
    }

    // Clean up expired in-memory buckets periodically with unref so it does not hold process open
    this.cleanupTimer = setInterval(() => this.cleanupMemoryBuckets(), 60000);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  public async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
      this.redisClient = null;
    }
    this.memoryBuckets.clear();
  }

  private cleanupMemoryBuckets() {
    const now = Date.now();
    const windowMs = 60000;
    for (const [key, timestamps] of this.memoryBuckets.entries()) {
      const valid = timestamps.filter(t => now - t < windowMs);
      if (valid.length === 0) {
        this.memoryBuckets.delete(key);
      } else {
        this.memoryBuckets.set(key, valid);
      }
    }
  }

  public async checkRateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
    identifier: string,
    customLimit?: number,
    customWindowMs?: number
  ): Promise<boolean> {
    const maxRequests = customLimit ?? this.config.RATE_LIMIT_RPM;
    const windowMs = customWindowMs ?? 60000;
    const now = Date.now();
    const key = `ratelimit:${identifier}`;

    // Use Redis if active
    if (this.redisClient && this.redisClient.status === 'ready') {
      try {
        const multi = this.redisClient.multi();
        multi.zremrangebyscore(key, 0, now - windowMs);
        multi.zadd(key, now, `${now}-${Math.random()}`);
        multi.zcard(key);
        multi.expire(key, Math.ceil(windowMs / 1000) + 5);
        const results = await multi.exec();

        const count = results ? (results[2][1] as number) : 1;
        if (count > maxRequests) {
          const retrySec = Math.max(1, Math.ceil(windowMs / 1000 / 2));
          const sanitized = ErrorSanitizerService.rateLimitError(retrySec);
          reply.header('Retry-After', String(retrySec));
          reply.code(sanitized.statusCode).send(sanitized.payload);
          return false;
        }
        return true;
      } catch {
        // Fall back to memory on Redis error
      }
    }

    // In-memory sliding window
    const timestamps = this.memoryBuckets.get(key) || [];
    const validTimestamps = timestamps.filter(t => now - t < windowMs);

    if (validTimestamps.length >= maxRequests) {
      const retrySec = Math.max(1, Math.ceil(windowMs / 1000 / 2));
      const sanitized = ErrorSanitizerService.rateLimitError(retrySec);
      reply.header('Retry-After', String(retrySec));
      reply.code(sanitized.statusCode).send(sanitized.payload);
      return false;
    }

    validTimestamps.push(now);
    this.memoryBuckets.set(key, validTimestamps);
    return true;
  }
}
