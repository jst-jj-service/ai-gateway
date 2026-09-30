import dotenv from 'dotenv';
import { z } from 'zod';
import { DEFAULT_UPSTREAM_KEYS, UpstreamKey } from './services/upstream-keys';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const DEFAULT_DEV_JWT_SECRET = 'gateway-jwt-dev-secret-key-32-chars-min-change-in-prod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().default('file:./dev.db'),
  REDIS_URL: z.string().optional().default(''),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').default(DEFAULT_DEV_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default('7d'),

  UPSTREAM_BASE_URL: z.string().url().default('https://api.hzapi.vip'),
  UPSTREAM_API_KEY: z.string().default(''),
  UPSTREAM_KEYS_JSON: z.string().optional().default(''),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().default(60000),

  RATE_LIMIT_RPM: z.coerce.number().default(60),
  RATE_LIMIT_BURST: z.coerce.number().default(10),

  NEXT_PUBLIC_SHOP_URL: z.string().default('https://your-shop.com'),
  CORS_ORIGIN: z.string().default('*'),

  DATA_STORE_PATH: z.string().default('./data/gateway-data.json'),

  INITIAL_ADMIN_EMAIL: z.string().email().default(process.env.ADMIN_EMAIL || 'admin@gateway.local'),
  INITIAL_ADMIN_PASSWORD: z.string().min(8, 'Admin password must be at least 8 characters').optional()
}).refine(data => {
  if (data.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_DEV_JWT_SECRET) {
      return false;
    }
  }
  return true;
}, {
  message: 'In production, a strong, custom JWT_SECRET (min 32 chars) must be set via environment variable.',
  path: ['JWT_SECRET']
}).refine(data => {
  if (data.NODE_ENV === 'production') {
    const adminPass = process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD;
    if (!adminPass || adminPass.length < 12) {
      return false;
    }
  }
  return true;
}, {
  message: 'In production, a strong ADMIN_PASSWORD (min 12 chars) must be provided in environment variables.',
  path: ['INITIAL_ADMIN_PASSWORD']
});

export type Config = z.infer<typeof envSchema> & {
  INITIAL_ADMIN_PASSWORD: string;
  UPSTREAM_KEYS: UpstreamKey[];
};

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  let parsedData: z.infer<typeof envSchema>;

  if (!result.success) {
    if (isProduction) {
      console.error('CRITICAL: Invalid production environment configuration:', result.error.format());
      throw new Error('Invalid production environment configuration. Check logs for details.');
    }
    console.warn('Environment configuration warnings (using dev fallbacks):', result.error.format());
    parsedData = envSchema.parse({
      JWT_SECRET: DEFAULT_DEV_JWT_SECRET
    });
  } else {
    parsedData = result.data;
  }

  // Parse upstream keys from JSON if provided, otherwise default to the 6 predefined HZAPI keys
  let upstreamKeys: UpstreamKey[] = DEFAULT_UPSTREAM_KEYS;
  if (parsedData.UPSTREAM_KEYS_JSON && parsedData.UPSTREAM_KEYS_JSON.trim()) {
    try {
      const parsedKeys = JSON.parse(parsedData.UPSTREAM_KEYS_JSON);
      if (Array.isArray(parsedKeys) && parsedKeys.length > 0) {
        upstreamKeys = parsedKeys;
      }
    } catch (err) {
      console.warn('[Config] Failed to parse UPSTREAM_KEYS_JSON, falling back to default keys:', err);
    }
  }

  // Resolve admin password safely without hardcoded leaks
  let adminPassword = parsedData.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD;
  if (!adminPassword) {
    if (isTest) {
      adminPassword = 'TestSecurePassword123!';
    } else {
      // Generate a strong ephemeral password in development and print once
      const crypto = require('crypto');
      adminPassword = `gw_${crypto.randomBytes(12).toString('hex')}`;
      console.log('----------------------------------------------------');
      console.log(`[Config] Generated ephemeral Admin Password: ${adminPassword}`);
      console.log(`[Config] Set ADMIN_PASSWORD in your .env to specify your own.`);
      console.log('----------------------------------------------------');
    }
  }

  return {
    ...parsedData,
    INITIAL_ADMIN_PASSWORD: adminPassword,
    UPSTREAM_KEYS: upstreamKeys
  };
}

export const config = loadConfig();
