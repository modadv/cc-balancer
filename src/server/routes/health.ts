import type { FastifyInstance } from 'fastify';

export async function registerHealthRoute(app: FastifyInstance, path: string): Promise<void> {
  app.get(path, async () => ({ status: 'ok' }));
}
