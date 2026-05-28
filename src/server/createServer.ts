import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Config } from '../core/types.js';
import { Dispatcher } from '../core/dispatcher.js';
import { Scheduler } from '../core/scheduler.js';
import { UpstreamPool } from '../core/upstreamPool.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerUpstreamsRoute } from './routes/upstreams.js';
import { LOG_REDACT_PATHS } from '../utils/logger.js';

function extractAuthToken(request: FastifyRequest): string | null {
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }

  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isPublicPath(config: Config, path: string): boolean {
  if (config.health.enable && path === config.health.path) {
    return true;
  }
  if (config.metrics.enable && path === config.metrics.path) {
    return true;
  }
  if (config.status.enable && path === config.status.path) {
    return true;
  }
  return false;
}

function registerGatewayAuth(app: FastifyInstance, config: Config): void {
  if (!config.gateway.authToken) {
    return;
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestPath = request.raw.url?.split('?')[0] ?? request.url;
    if (isPublicPath(config, requestPath)) {
      return;
    }

    const token = extractAuthToken(request);
    if (token === config.gateway.authToken) {
      return;
    }

    if (!token) {
      return reply.code(403).send({
        error: { type: 'forbidden', message: 'Request not allowed' }
      });
    }

    request.log.warn({ path: requestPath, remoteAddress: request.ip }, 'unauthorized gateway access attempt');
    return reply.code(401).send({
      error: { type: 'authentication_error', message: 'Invalid x-api-key' }
    });
  });
}

export async function createServer(config: Config) {
  const app = Fastify({
    logger: {
      level: config.log.level,
      redact: LOG_REDACT_PATHS
    }
  });

  registerGatewayAuth(app, config);

  const upstreamPool = new UpstreamPool(config);
  const scheduler = new Scheduler(config, upstreamPool, app.log);
  const dispatcher = new Dispatcher(config, scheduler, upstreamPool);

  if (config.health.enable) {
    await registerHealthRoute(app, config.health.path);
  }

  if (config.metrics.enable) {
    await registerMetricsRoute(app, config.metrics.path, upstreamPool, scheduler);
  }

  if (config.status.enable) {
    await registerUpstreamsRoute(app, config.status.path, upstreamPool);
  }

  await registerProxyRoutes(app, dispatcher);

  return app;
}
