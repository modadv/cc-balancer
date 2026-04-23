import { describe, expect, it } from 'vitest';

import { Scheduler } from '../../src/core/scheduler.js';
import { UpstreamPool } from '../../src/core/upstreamPool.js';
import type { Config } from '../../src/core/types.js';

const baseConfig: Config = {
  server: { host: '127.0.0.1', port: 8000 },
  gateway: {},
  log: { level: 'info' },
  routing: { strategy: 'least-fail' },
  upstreams: [
    { id: 'a', baseUrl: 'https://a.example.com', apiKey: 'a' },
    { id: 'b', baseUrl: 'https://b.example.com', apiKey: 'b' }
  ],
  retry: {
    maxAttempts: 2,
    perUpstreamRetries: 1,
    backoff: {
      type: 'fixed',
      baseDelayMs: 1,
      maxDelayMs: 1
    }
  },
  cooldown: {
    rateLimit: 60,
    quotaExceeded: 300,
    serverError: 10,
    networkError: 15
  },
  health: { enable: true, path: '/health' },
  metrics: { enable: true, path: '/metrics' },
  status: { enable: true, path: '/upstreams' }
};

describe('Scheduler', () => {
  it('prefers the least-failing available upstream', () => {
    const pool = new UpstreamPool(baseConfig);
    const scheduler = new Scheduler(baseConfig, pool);
    const [a, b] = pool.getAll();

    pool.markFailure(a!);
    pool.markFailure(a!);
    pool.markFailure(b!);

    const selected = scheduler.selectUpstream();

    expect(selected?.id).toBe('b');
  });

  it('ignores upstreams in cooldown', () => {
    const pool = new UpstreamPool(baseConfig);
    const scheduler = new Scheduler(baseConfig, pool);
    const [a] = pool.getAll();

    pool.applyCooldown(a!, 60, Date.now());

    const selected = scheduler.selectUpstream();

    expect(selected?.id).toBe('b');
  });
});
