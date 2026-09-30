import { FastifyInstance } from 'fastify';
import { UsageService } from '../services/usage.service';
import { AuthPlugin } from '../plugins/auth';

export async function usageRoutes(
  fastify: FastifyInstance,
  options: { usageService: UsageService; authPlugin: AuthPlugin }
) {
  const { usageService, authPlugin } = options;

  // Get user dashboard analytics
  fastify.get('/api/usage/dashboard', async (req, reply) => {
    const authenticated = await authPlugin.authenticate(req, reply);
    if (!authenticated || !req.user) return;

    const data = await usageService.getUserDashboardData(req.user.id);
    return reply.send(data);
  });
}
