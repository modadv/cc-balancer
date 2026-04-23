import type { FastifyInstance } from 'fastify';

import { UpstreamPool } from '../../core/upstreamPool.js';

export async function registerUpstreamsRoute(app: FastifyInstance, path: string, upstreamPool: UpstreamPool): Promise<void> {
  app.get(path, async () => ({
    upstreams: upstreamPool.getStatusSnapshots()
  }));
}
