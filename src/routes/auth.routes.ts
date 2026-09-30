import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../services/auth.service';
import { QuotaService } from '../services/quota.service';
import { AuthPlugin } from '../plugins/auth';
import { IStore } from '../db/store';

import { GatewayRateLimiter } from '../plugins/rate-limiter';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string()
});

const createKeySchema = z.object({
  name: z.string().min(1).max(50).optional().default('Default Key')
});

export async function authRoutes(
  fastify: FastifyInstance,
  options: {
    authService: AuthService;
    quotaService: QuotaService;
    authPlugin: AuthPlugin;
    store: IStore;
    rateLimiter?: GatewayRateLimiter;
  }
) {
  const { authService, quotaService, authPlugin, store, rateLimiter } = options;

  // Register
  fastify.post('/api/auth/register', async (req, reply) => {
    if (rateLimiter) {
      const isAllowed = await rateLimiter.checkRateLimit(req, reply, `register:${req.ip}`, 10, 60000);
      if (!isAllowed) return;
    }

    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: {
          message: 'Invalid registration details',
          details: parseResult.error.errors.map(e => e.message)
        }
      });
    }

    try {
      const user = await authService.register(parseResult.data);
      const token = fastify.jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        { expiresIn: '7d' }
      );

      return reply.code(201).send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role
        },
        token
      });
    } catch (err: any) {
      return reply.code(400).send({
        error: {
          message: err.message || 'Registration failed'
        }
      });
    }
  });

  // Login
  fastify.post('/api/auth/login', async (req, reply) => {
    if (rateLimiter) {
      const isAllowed = await rateLimiter.checkRateLimit(req, reply, `login:${req.ip}`, 10, 60000);
      if (!isAllowed) return;
    }

    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: {
          message: 'Please provide a valid email and password'
        }
      });
    }

    const { email, password } = parseResult.data;
    const user = await authService.validateUser(email, password);

    if (!user) {
      return reply.code(401).send({
        error: {
          message: 'Invalid email or password'
        }
      });
    }

    const token = fastify.jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      { expiresIn: '7d' }
    );

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      token
    });
  });

  // Get current user profile + quota
  fastify.get('/api/auth/me', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    const user = await store.getUserById(req.user.id);
    if (!user) {
      return reply.code(404).send({ error: { message: 'User not found' } });
    }

    const quota = await quotaService.getFormattedQuota(user.id);

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      quota
    });
  });

  // Get user's API keys
  fastify.get('/api/auth/keys', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    const keys = await store.getApiKeysByUserId(req.user.id);
    return reply.send({
      keys: keys.map(k => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt
      }))
    });
  });

  // Create new API key
  fastify.post('/api/auth/keys', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    if (req.user.apiKeyId) {
      return reply.code(403).send({
        error: { message: 'API keys cannot manage account keys. Please log in to your dashboard.' }
      });
    }

    const existingKeys = await store.getApiKeysByUserId(req.user.id);
    if (existingKeys.length >= 20) {
      return reply.code(400).send({
        error: { message: 'Maximum limit of 20 active API keys reached. Please revoke unused keys first.' }
      });
    }

    const parseResult = createKeySchema.safeParse(req.body || {});
    const name = parseResult.success ? parseResult.data.name : 'Default Key';

    const { apiKey, rawKey } = await authService.createApiKey(req.user.id, name);

    return reply.code(201).send({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        keyPrefix: apiKey.keyPrefix,
        createdAt: apiKey.createdAt
      },
      rawKey,
      warning: 'Make sure to copy your API key now. You will not be able to see it again!'
    });
  });

  // Revoke API key
  fastify.delete('/api/auth/keys/:id', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    if (req.user.apiKeyId) {
      return reply.code(403).send({
        error: { message: 'API keys cannot manage account keys. Please log in to your dashboard.' }
      });
    }

    const { id } = req.params as { id: string };
    const success = await store.revokeApiKey(id, req.user.id);

    if (!success) {
      return reply.code(404).send({ error: { message: 'API key not found or already revoked' } });
    }

    return reply.send({ success: true, message: 'API key revoked successfully' });
  });

  // Change password
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(6, 'New password must be at least 6 characters')
  });

  fastify.post('/api/auth/change-password', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    if (req.user.apiKeyId) {
      return reply.code(403).send({
        error: { message: 'API keys cannot be used to change account password. Please log in with your dashboard credentials.' }
      });
    }

    const parseResult = changePasswordSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: { message: parseResult.error.errors[0]?.message || 'Invalid password parameters' }
      });
    }

    const { currentPassword, newPassword } = parseResult.data;
    const result = await authService.changePassword(req.user.id, currentPassword, newPassword);
    if (!result.success) {
      return reply.code(400).send({ error: { message: result.error || 'Password update failed' } });
    }

    return reply.send({ success: true, message: 'Password updated successfully' });
  });
}
