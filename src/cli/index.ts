#!/usr/bin/env node
import { Command } from 'commander';

import { registerDoctorCommand } from './commands/doctor.js';
import { registerStartCommand } from './commands/start.js';
import { registerValidateCommand } from './commands/validate.js';

const program = new Command();

program.name('cc-balancer').description('Claude API gateway with multi-upstream failover').version('0.1.0');

registerStartCommand(program);
registerValidateCommand(program);
registerDoctorCommand(program);

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
