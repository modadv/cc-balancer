#!/usr/bin/env node
import { createRequire } from 'node:module';

import { Command } from 'commander';

import { registerDoctorCommand } from './commands/doctor.js';
import { registerStartCommand } from './commands/start.js';
import { registerValidateCommand } from './commands/validate.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json') as { version: string };

const program = new Command();

program.name('cc-balancer').description('Claude API gateway with multi-upstream failover').version(version);

registerStartCommand(program);
registerValidateCommand(program);
registerDoctorCommand(program);

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
