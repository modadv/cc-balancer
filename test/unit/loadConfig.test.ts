import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/loadConfig.js';

describe('loadConfig', () => {
  afterEach(() => {
    delete process.env.LOAD_CONFIG_KEY_A;
    delete process.env.LOAD_CONFIG_KEY_B;
  });

  it('applies defaults and environment expansion', async () => {
    process.env.LOAD_CONFIG_KEY_A = 'alpha';
    process.env.LOAD_CONFIG_KEY_B = 'beta';

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cc-balancer-config-'));
    const configPath = path.join(tempDir, 'config.yaml');

    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 9000
concurrency:
  acquireTimeoutMs: 500
  maxPendingRequests: 42
upstreams:
  - id: a
    baseUrl: https://example-a.test
    apiKey: \${LOAD_CONFIG_KEY_A}
    maxConcurrentRequests: 4
  - id: b
    baseUrl: https://example-b.test
    apiKey: \${LOAD_CONFIG_KEY_B}
`
    );

    const config = await loadConfig({ configPath, hostOverride: '0.0.0.0', portOverride: 9100 });

    expect(config.server).toEqual({ host: '0.0.0.0', port: 9100 });
    expect(config.retry.maxAttempts).toBe(2);
    expect(config.retry.perUpstreamRetries).toBe(2);
    expect(config.log.level).toBe('info');
    expect(config.routing.strategy).toBe('least-fail');
    expect(config.concurrency).toEqual({ acquireTimeoutMs: 500, maxPendingRequests: 42 });
    expect(config.upstreams[0]?.apiKey).toBe('alpha');
    expect(config.upstreams[0]?.maxConcurrentRequests).toBe(4);
    expect(config.upstreams[1]?.apiKey).toBe('beta');
  });

  it.each(['warn', 'error'] as const)('accepts log level %s from config', async (level) => {
    process.env.LOAD_CONFIG_KEY_A = 'alpha';

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cc-balancer-config-'));
    const configPath = path.join(tempDir, 'config.yaml');

    await writeFile(
      configPath,
      `
server:
  host: 127.0.0.1
  port: 9000
log:
  level: ${level}
upstreams:
  - id: a
    baseUrl: https://example-a.test
    apiKey: \${LOAD_CONFIG_KEY_A}
`
    );

    const config = await loadConfig({ configPath });

    expect(config.log.level).toBe(level);
  });
});
