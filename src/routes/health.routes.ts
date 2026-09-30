import { FastifyInstance } from 'fastify';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'ai-gateway',
      timestamp: new Date().toISOString()
    };
  });

  fastify.get('/api/health', async () => {
    return {
      status: 'ok',
      service: 'ai-gateway',
      timestamp: new Date().toISOString()
    };
  });
}
