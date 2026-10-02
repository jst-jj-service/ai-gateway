import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { Config, config as defaultConfig } from './config';
import { IStore, defaultStore } from './db/store';
import { AuthService } from './services/auth.service';
import { QuotaService } from './services/quota.service';
import { CdkService } from './services/cdk.service';
import { UsageService } from './services/usage.service';
import { ProxyService } from './services/proxy.service';
import { GatewayRateLimiter } from './plugins/rate-limiter';
import { AuthPlugin } from './plugins/auth';
import { setupErrorSanitizer } from './plugins/error-sanitizer';

import { healthRoutes } from './routes/health.routes';
import { authRoutes } from './routes/auth.routes';
import { cdkRoutes } from './routes/cdk.routes';
import { usageRoutes } from './routes/usage.routes';
import { v1Routes } from './routes/v1.routes';
import { adminRoutes } from './routes/admin.routes';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';

export interface BuildServerOptions {
  config?: Config;
  store?: IStore;
  logger?: boolean;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const cfg = options.config || defaultConfig;
  const store = options.store || defaultStore;

  const app = Fastify({
    logger: options.logger ?? (cfg.NODE_ENV !== 'test'),
    bodyLimit: 10 * 1024 * 1024 // 10MB request payload limit
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });

  // CORS configuration
  await app.register(cors, {
    origin: cfg.CORS_ORIGIN === '*' ? true : [cfg.CORS_ORIGIN, 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  });

  // JWT configuration
  await app.register(jwt, {
    secret: cfg.JWT_SECRET
  });

  // Global error sanitizer
  setupErrorSanitizer(app);

  // Instantiate services
  const authService = new AuthService(store);
  const quotaService = new QuotaService(store);
  const cdkService = new CdkService(store);
  const usageService = new UsageService(store);
  const proxyService = new ProxyService(cfg, usageService, quotaService);
  const rateLimiter = new GatewayRateLimiter(cfg);
  const authPlugin = new AuthPlugin(authService);

  // Lifecycle shutdown hook: cleanly close rate limiter timers and flush/close store
  app.addHook('onClose', async () => {
    await rateLimiter.close();
    if (typeof store.close === 'function') {
      store.close();
    }
  });

  // Seed initial admin
  await authService.seedInitialAdmin(cfg.INITIAL_ADMIN_EMAIL, cfg.INITIAL_ADMIN_PASSWORD);

  // Register route plugins
  await app.register(healthRoutes);
  await app.register(authRoutes, { authService, quotaService, authPlugin, store, rateLimiter });
  await app.register(cdkRoutes, { cdkService, quotaService, authPlugin, rateLimiter });
  await app.register(usageRoutes, { usageService, authPlugin });
  await app.register(v1Routes, { proxyService, quotaService, authPlugin, rateLimiter, config: cfg });
  await app.register(adminRoutes, { store, quotaService, usageService, authPlugin });

  // Serve Next.js static client dashboard if public directory exists
  const publicDir = path.resolve(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html']
    });

    app.setNotFoundHandler(async (req, reply) => {
      // API routes return standard JSON error
      if (req.url.startsWith('/api') || req.url.startsWith('/v1') || req.url.startsWith('/health')) {
        return reply.code(404).send({
          error: {
            message: `Endpoint ${req.method} ${req.url} not found`,
            type: 'invalid_request_error',
            code: 'not_found',
            status: 404
          }
        });
      }

      // Check for matching static file or clean html route
      const cleanPath = req.url.split('?')[0].replace(/^\/+/, '');
      const directFile = path.join(publicDir, cleanPath);
      const indexFile = path.join(publicDir, cleanPath, 'index.html');
      const htmlFile = path.join(publicDir, `${cleanPath}.html`);

      if (cleanPath && fs.existsSync(directFile) && fs.statSync(directFile).isFile()) {
        return reply.sendFile(cleanPath);
      }
      if (cleanPath && fs.existsSync(indexFile)) {
        return reply.sendFile(path.posix.join(cleanPath, 'index.html'));
      }
      if (cleanPath && fs.existsSync(htmlFile)) {
        return reply.sendFile(`${cleanPath}.html`);
      }

      // Fallback to root index.html for client-side SPA routing
      const mainIndex = path.join(publicDir, 'index.html');
      if (fs.existsSync(mainIndex)) {
        return reply.sendFile('index.html');
      }

      return reply.code(404).send({
        message: `Route ${req.method}:${req.url} not found`,
        error: 'Not Found',
        statusCode: 404
      });
    });
  }

  return app;
}
