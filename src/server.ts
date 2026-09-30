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

  return app;
}
