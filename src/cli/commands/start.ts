import type { Command } from 'commander';

import { loadConfig } from '../../config/loadConfig.js';
import { createServer } from '../../server/createServer.js';

async function registerShutdown(server: Awaited<ReturnType<typeof createServer>>) {
  const shutdown = async (signal: string) => {
    server.log.info({ signal }, 'shutting down gateway');
    await server.close();
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

      await server.listen({
        host: config.server.host,
        port: config.server.port
      });

      server.log.info({ host: config.server.host, port: config.server.port }, 'cc-balancer started');
    });
}
