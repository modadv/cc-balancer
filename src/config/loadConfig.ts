import { readFile } from 'node:fs/promises';
import path from 'node:path';

import dotenv from 'dotenv';
import yaml from 'js-yaml';

import { expandEnv } from './expandEnv.js';
import { parseConfig } from './schema.js';
import type { Config } from '../core/types.js';

export type LoadConfigOptions = {
  configPath: string;
  hostOverride?: string;
  portOverride?: number;
};

export async function loadConfig(options: LoadConfigOptions): Promise<Config> {
  const absoluteConfigPath = path.resolve(options.configPath);
  dotenv.config({ path: path.resolve(process.cwd(), '.env') });

  const file = await readFile(absoluteConfigPath, 'utf8');
  const parsedYaml = yaml.load(file);
  const expanded = expandEnv(parsedYaml);
  const config = parseConfig(expanded);

  return {
    ...config,
    server: {
      host: options.hostOverride ?? config.server.host,
      port: options.portOverride ?? config.server.port
    }
  };
}
