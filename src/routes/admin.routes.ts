import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IStore } from '../db/store';
import { QuotaService } from '../services/quota.service';
import { UsageService } from '../services/usage.service';
import { AuthPlugin } from '../plugins/auth';
import { formatTokens } from '../utils/formatters';

const updateStatusSchema = z.object({
  isActive: z.boolean()
});

const addCreditsSchema = z.object({
  tokens: z.coerce.number().int().positive('Token amount must be greater than 0')
});

export async function adminRoutes(
  fastify: FastifyInstance,
  options: {
    store: IStore;
    quotaService: QuotaService;
    usageService: UsageService;
    authPlugin: AuthPlugin;
  }
) {
  const { store, quotaService, usageService, authPlugin } = options;

  // GET /api/admin/stats - Aggregate system stats
  fastify.get('/api/admin/stats', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const stats = await store.getSystemStats();
    return reply.send({
      ...stats,
      totalTokensRedeemedFormatted: formatTokens(stats.totalTokensRedeemed),
      totalTokensUsedFormatted: formatTokens(stats.totalTokensUsed),
      totalTokensRemainingFormatted: formatTokens(stats.totalTokensRemaining)
    });
  });

  // GET /api/admin/users - List users with quota and usage summary
  fastify.get('/api/admin/users', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const query = req.query as { search?: string } | undefined;
    let users = await store.getAdminUsers();

    if (query?.search && query.search.trim()) {
      const search = query.search.toLowerCase().trim();
      users = users.filter(u =>
        u.email.toLowerCase().includes(search) ||
        (u.name && u.name.toLowerCase().includes(search)) ||
        u.id.toLowerCase().includes(search)
      );
    }

    const formattedUsers = users.map(u => ({
      ...u,
      quota: {
        ...u.quota,
        totalTokensFormatted: formatTokens(u.quota.totalTokens),
        usedTokensFormatted: formatTokens(u.quota.usedTokens),
        remainingTokensFormatted: formatTokens(u.quota.remainingTokens),
        cachedTokensFormatted: formatTokens(u.quota.cachedTokens)
      }
    }));

    return reply.send({
      total: formattedUsers.length,
      users: formattedUsers
    });
  });

  // GET /api/admin/users/:id - Get detailed user profile
  fastify.get('/api/admin/users/:id', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const { id } = req.params as { id: string };
    const user = await store.getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: { message: 'User not found' } });
    }

    const quota = await quotaService.getFormattedQuota(id);
    const apiKeys = await store.getApiKeysByUserId(id);
    const usageData = await usageService.getUserDashboardData(id);

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      quota,
      apiKeysCount: apiKeys.length,
      apiKeys: apiKeys.map(k => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        isActive: k.isActive,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt
      })),
      usage: usageData
    });
  });

  // PATCH /api/admin/users/:id/status - Enable/disable user account
  fastify.patch('/api/admin/users/:id/status', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin || !req.user) return;

    const { id } = req.params as { id: string };

    if (id === req.user.id) {
      return reply.code(400).send({
        error: { message: 'You cannot modify your own administrator account status' }
      });
    }

    const parseResult = updateStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: { message: 'Invalid payload: isActive boolean is required' }
      });
    }

    try {
      const updated = await store.updateUserStatus(id, parseResult.data.isActive);
      return reply.send({
        success: true,
        message: `User ${updated.email} is now ${updated.isActive ? 'active' : 'disabled'}`,
        user: {
          id: updated.id,
          email: updated.email,
          isActive: updated.isActive,
          updatedAt: updated.updatedAt
        }
      });
    } catch (err: any) {
      return reply.code(404).send({
        error: { message: err.message || 'User not found' }
      });
    }
  });

  // POST /api/admin/users/:id/credits - Manually add tokens to user quota
  fastify.post('/api/admin/users/:id/credits', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const { id } = req.params as { id: string };
    const user = await store.getUserById(id);
    if (!user) {
      return reply.code(404).send({ error: { message: 'User not found' } });
    }

    const parseResult = addCreditsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: {
          message: parseResult.error.errors[0]?.message || 'Invalid token amount'
        }
      });
    }

    const { tokens } = parseResult.data;
    await store.addTokensToQuota(id, BigInt(tokens));
    const formattedQuota = await quotaService.getFormattedQuota(id);

    return reply.send({
      success: true,
      message: `Successfully added ${formatTokens(tokens)} tokens to ${user.email}`,
      tokensAdded: tokens,
      tokensAddedFormatted: formatTokens(tokens),
      quota: formattedQuota
    });
  });

  // DELETE /api/admin/users/:id - Delete user account safely
  fastify.delete('/api/admin/users/:id', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin || !req.user) return;

    const { id } = req.params as { id: string };

    if (id === req.user.id) {
      return reply.code(400).send({
        error: { message: 'You cannot delete your own administrator account' }
      });
    }

    const success = await store.deleteUser(id);
    if (!success) {
      return reply.code(404).send({ error: { message: 'User not found' } });
    }

    return reply.send({
      success: true,
      message: 'User account and associated data removed successfully'
    });
  });
}
