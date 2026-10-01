import { FastifyInstance } from 'fastify';
import { ProxyService } from '../services/proxy.service';
import { QuotaService } from '../services/quota.service';
import { AuthPlugin } from '../plugins/auth';
import { GatewayRateLimiter } from '../plugins/rate-limiter';
import { ErrorSanitizerService } from '../services/error-sanitizer.service';
import { Config } from '../config';

export async function v1Routes(
  fastify: FastifyInstance,
  options: {
    proxyService: ProxyService;
    quotaService: QuotaService;
    authPlugin: AuthPlugin;
    rateLimiter: GatewayRateLimiter;
    config: Config;
  }
) {
  const { proxyService, quotaService, authPlugin, rateLimiter, config } = options;

  // Middleware / PreHandler for OpenAI proxy endpoints
  const proxyPreHandler = async (req: any, reply: any) => {
    // 1. Authenticate (API key or JWT)
    const isAuth = await authPlugin.authenticate(req, reply);
    if (!isAuth || !req.user) {
      return false;
    }

    // 2. Rate limit check (keyed by userId or apiKeyId)
    const limitKey = req.user.apiKeyId || req.user.id;
    const isAllowed = await rateLimiter.checkRateLimit(req, reply, limitKey);
    if (!isAllowed) {
      return false;
    }

    // 3. Quota verification check
    const hasQuota = await quotaService.hasRemainingQuota(req.user.id, 1);
    if (!hasQuota) {
      const quotaErr = ErrorSanitizerService.quotaExhaustedError(config.NEXT_PUBLIC_SHOP_URL);
      if (req.url.includes('/messages')) {
        reply.code(quotaErr.statusCode).send({
          type: 'error',
          error: {
            type: 'quota_exhausted_error',
            message: quotaErr.payload.error.message,
            suggestion: quotaErr.payload.error.suggestion
          }
        });
      } else {
        reply.code(quotaErr.statusCode).send(quotaErr.payload);
      }
      return false;
    }

    return true;
  };

  // POST /v1/chat/completions (OpenAI compatible)
  fastify.post('/v1/chat/completions', async (req, reply) => {
    const passed = await proxyPreHandler(req, reply);
    if (!passed) return;

    return proxyService.handleChatCompletion(req, reply, req.user!);
  });

  // POST /v1/responses (OpenAI Responses API compatible)
  fastify.post('/v1/responses', async (req, reply) => {
    const passed = await proxyPreHandler(req, reply);
    if (!passed) return;

    return proxyService.handleResponses(req, reply, req.user!);
  });

  // POST /v1/messages (Anthropic Messages API compatible for Claude Code & Anthropic SDKs)
  fastify.post('/v1/messages', async (req, reply) => {
    const passed = await proxyPreHandler(req, reply);
    if (!passed) return;

    return proxyService.handleMessages(req, reply, req.user!);
  });

  // POST /messages (Direct route for clients pointing BASE_URL to /v1 or root)
  fastify.post('/messages', async (req, reply) => {
    const passed = await proxyPreHandler(req, reply);
    if (!passed) return;

    return proxyService.handleMessages(req, reply, req.user!);
  });

  // GET /v1/models
  fastify.get('/v1/models', async (req, reply) => {
    const isAuth = await authPlugin.authenticate(req, reply);
    if (!isAuth || !req.user) return;

    const limitKey = req.user.apiKeyId || req.user.id;
    const isAllowed = await rateLimiter.checkRateLimit(req, reply, limitKey);
    if (!isAllowed) return;

    return proxyService.handleGetModels(reply);
  });
}
