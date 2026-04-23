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

function extractBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isPublicPath(config: Config, path: string): boolean {
  return config.health.enable && path === config.health.path;
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

    const token = extractBearerToken(request);
    if (token === config.gateway.authToken) {
      return;
    }

    reply.header('www-authenticate', 'Bearer');
    return reply.code(401).send({
      error: 'Unauthorized gateway access'
    });
  });
}

export async function createServer(config: Config) {
  const app = Fastify({
    logger: {
      level: config.log.level
    }
  });

  registerGatewayAuth(app, config);

  const upstreamPool = new UpstreamPool(config);
  const scheduler = new Scheduler(config, upstreamPool);
  const dispatcher = new Dispatcher(config, scheduler, upstreamPool);

  if (config.health.enable) {
    await registerHealthRoute(app, config.health.path);
  }

  if (config.metrics.enable) {
    await registerMetricsRoute(app, config.metrics.path, upstreamPool);
  }

  if (config.status.enable) {
    await registerUpstreamsRoute(app, config.status.path, upstreamPool);
  }

  await registerProxyRoutes(app, dispatcher);

  return app;
}
