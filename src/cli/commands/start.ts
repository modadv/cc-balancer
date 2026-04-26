import type { Command } from 'commander';

import { loadConfig } from '../../config/loadConfig.js';
import { createServer } from '../../server/createServer.js';
import type { Config } from '../../core/types.js';

function summarizeRuntimeConfig(config: Config) {
  return {
    server: config.server,
    log: config.log,
    routing: config.routing,
    concurrency: config.concurrency,
    retry: config.retry,
    cooldown: config.cooldown,
    gatewayAuthEnabled: Boolean(config.gateway.authToken),
    routes: {
      health: config.health,
      metrics: config.metrics,
      status: config.status
    },
    upstreams: config.upstreams.map((upstream) => ({
      id: upstream.id,
      baseUrl: upstream.baseUrl.replace(/\/+$/, ''),
      weight: upstream.weight ?? 1,
      maxConcurrentRequests: upstream.maxConcurrentRequests ?? null
    }))
  };
}

async function registerShutdown(server: Awaited<ReturnType<typeof createServer>>) {
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'shutting down gateway');
    await server.close();
    server.log.info({ signal }, 'gateway shutdown complete');
    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start the gateway server')
    .requiredOption('-c, --config <path>', 'Path to config yaml')
    .option('--host <host>', 'Override listen host')
    .option('--port <port>', 'Override listen port', (value) => Number(value))
    .action(async (options) => {
      const config = await loadConfig({
        configPath: options.config,
        hostOverride: options.host,
        portOverride: options.port
      });

      const server = await createServer(config);
      await registerShutdown(server);
      server.log.info(summarizeRuntimeConfig(config), 'cc-balancer runtime config loaded');

      await server.listen({
        host: config.server.host,
        port: config.server.port
      });

      server.log.info({ host: config.server.host, port: config.server.port }, 'cc-balancer started');
    });
}
