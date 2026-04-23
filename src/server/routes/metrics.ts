import type { FastifyInstance } from 'fastify';

import { UpstreamPool } from '../../core/upstreamPool.js';

export async function registerMetricsRoute(app: FastifyInstance, path: string, upstreamPool: UpstreamPool): Promise<void> {
  app.get(path, async () => upstreamPool.getMetrics());
}
