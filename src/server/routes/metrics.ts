import type { FastifyInstance } from 'fastify';

import { Scheduler } from '../../core/scheduler.js';
import { UpstreamPool } from '../../core/upstreamPool.js';

export async function registerMetricsRoute(app: FastifyInstance, path: string, upstreamPool: UpstreamPool, scheduler: Scheduler): Promise<void> {
  app.get(path, async () => ({
    ...upstreamPool.getMetrics(),
    pendingAcquireRequests: scheduler.getPendingAcquireCount()
  }));
}
