import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CdkService } from '../services/cdk.service';
import { QuotaService } from '../services/quota.service';
import { AuthPlugin } from '../plugins/auth';

import { GatewayRateLimiter } from '../plugins/rate-limiter';

const redeemSchema = z.object({
  code: z.string().min(1, 'Please enter a CDK activation key')
});

const generateSchema = z.object({
  count: z.number().int().min(1).max(500).default(1),
  tokenQuota: z.number().int().positive('Token quota must be greater than 0'), // e.g. 1000000
  tier: z.string().optional().default('standard'),
  expiresInDays: z.number().int().positive().optional()
});

export async function cdkRoutes(
  fastify: FastifyInstance,
  options: {
    cdkService: CdkService;
    quotaService: QuotaService;
    authPlugin: AuthPlugin;
    rateLimiter?: GatewayRateLimiter;
  }
) {
  const { cdkService, quotaService, authPlugin, rateLimiter } = options;

  // Redeem CDK (authenticated user)
  fastify.post('/api/cdk/redeem', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    if (rateLimiter) {
      const limitKey = `redeem:${req.user.id}`;
      const isAllowed = await rateLimiter.checkRateLimit(req, reply, limitKey, 15, 60000);
      if (!isAllowed) return;
    }

    const parseResult = redeemSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: {
          message: parseResult.error.errors[0]?.message || 'Invalid activation code format'
        }
      });
    }

    const { code } = parseResult.data;
    const result = await cdkService.redeem(code, req.user.id);

    if (!result.success) {
      return reply.code(400).send({
        error: {
          message: result.error || 'Redemption failed'
        }
      });
    }

    // Return updated quota balance
    const updatedQuota = await quotaService.getFormattedQuota(req.user.id);

    return reply.send({
      success: true,
      message: `Successfully redeemed ${result.tokensAddedFormatted} tokens!`,
      tokensAdded: result.tokensAdded,
      tokensAddedFormatted: result.tokensAddedFormatted,
      quota: updatedQuota
    });
  });

  // Admin: Generate CDK batch
  fastify.post('/api/cdk/admin/generate', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const parseResult = generateSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.code(400).send({
        error: {
          message: 'Invalid parameters for CDK generation',
          details: parseResult.error.errors.map(e => e.message)
        }
      });
    }

    try {
      const cdks = await cdkService.generateBatch(parseResult.data);
      return reply.code(201).send({
        success: true,
        count: cdks.length,
        cdks: cdks.map(c => ({
          id: c.id,
          code: c.code,
          tokenQuota: Number(c.tokenQuota),
          tier: c.tier,
          expiresAt: c.expiresAt,
          createdAt: c.createdAt
        }))
      });
    } catch (err: any) {
      return reply.code(400).send({
        error: {
          message: err.message || 'Failed to generate CDKs'
        }
      });
    }
  });

  // Admin: List all CDKs
  fastify.get('/api/cdk/admin/list', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const cdks = await cdkService.getAllCdks();
    return reply.send({
      total: cdks.length,
      cdks
    });
  });

  // Admin: Export CDKs as CSV
  fastify.get('/api/cdk/admin/export', async (req, reply) => {
    const isAdmin = await authPlugin.requireAdmin(req, reply);
    if (!isAdmin) return;

    const csvData = await cdkService.exportCdksAsCsv();
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="cdk-export-${Date.now()}.csv"`);
    return reply.send(csvData);
  });
}
