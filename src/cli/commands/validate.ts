import type { Command } from 'commander';

import { loadConfig } from '../../config/loadConfig.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate config file')
    .requiredOption('-c, --config <path>', 'Path to config yaml')
    .action(async (options) => {
      const config = await loadConfig({
        configPath: options.config
      });

      console.log(
        JSON.stringify(
          {
            valid: true,
            upstreamCount: config.upstreams.length,
            gatewayAuthEnabled: Boolean(config.gateway.authToken),
            server: config.server,
            routing: config.routing,
            concurrency: config.concurrency
          },
          null,
          2
        )
      );
    });
}
