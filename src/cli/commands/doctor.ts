import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';
import yaml from 'js-yaml';

import { loadConfig } from '../../config/loadConfig.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check runtime environment and config readiness')
    .requiredOption('-c, --config <path>', 'Path to config yaml')
    .action(async (options) => {
      const absoluteConfigPath = path.resolve(options.config);
      let configExists = true;
      let yamlReadable = true;
      let configSummary: unknown = null;
      let error: string | null = null;

      try {
        await access(absoluteConfigPath);
        await yaml.load(await readFile(absoluteConfigPath, 'utf8'));
        configSummary = await loadConfig({ configPath: absoluteConfigPath });
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        configExists = !/ENOENT/.test(message);
        yamlReadable = configExists && !/YAMLException|end of the stream|bad indentation|missed comma between flow collection entries/i.test(message);
        error = caught instanceof Error ? caught.message : String(caught);
      }

      console.log(
        JSON.stringify(
          {
            nodeVersion: process.version,
            cwd: process.cwd(),
            configPath: absoluteConfigPath,
            configExists,
            yamlReadable,
            configLoaded: configSummary !== null,
            error
          },
          null,
          2
        )
      );
    });
}
