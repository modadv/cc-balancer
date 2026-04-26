import { describe, expect, it } from 'vitest';

import { Scheduler } from '../../src/core/scheduler.js';
import { UpstreamPool } from '../../src/core/upstreamPool.js';
import type { Config } from '../../src/core/types.js';

const baseConfig: Config = {
  server: { host: '127.0.0.1', port: 8000 },
  gateway: {},
  log: { level: 'info' },
  routing: { strategy: 'least-fail' },
  concurrency: { acquireTimeoutMs: 20, maxPendingRequests: 10 },
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

  it('prefers an idle upstream over one with in-flight work', () => {
    const pool = new UpstreamPool(baseConfig);
    const scheduler = new Scheduler(baseConfig, pool);
    const [a] = pool.getAll();

    expect(pool.reserve(a!)).toBe(true);

    const selected = scheduler.selectUpstream();

    expect(selected?.id).toBe('b');
  });

  it('ignores upstreams that reached their concurrency limit', () => {
    const config: Config = {
      ...baseConfig,
      upstreams: [
        { id: 'a', baseUrl: 'https://a.example.com', apiKey: 'a', maxConcurrentRequests: 1 },
        { id: 'b', baseUrl: 'https://b.example.com', apiKey: 'b', maxConcurrentRequests: 1 }
      ]
    };
    const pool = new UpstreamPool(config);
    const scheduler = new Scheduler(config, pool);
    const [a] = pool.getAll();

    expect(pool.reserve(a!)).toBe(true);

    const selected = scheduler.selectUpstream();

    expect(selected?.id).toBe('b');
  });

  it('queues an acquire until capacity is released', async () => {
    const config: Config = {
      ...baseConfig,
      upstreams: [{ id: 'a', baseUrl: 'https://a.example.com', apiKey: 'a', maxConcurrentRequests: 1 }]
    };
    const pool = new UpstreamPool(config);
    const scheduler = new Scheduler(config, pool);
    const [a] = pool.getAll();

    expect(pool.reserve(a!)).toBe(true);

    const acquired = scheduler.acquireUpstream();
    expect(scheduler.getPendingAcquireCount()).toBe(1);

    pool.release(a!);

    await expect(acquired).resolves.toMatchObject({ id: 'a' });
    expect(scheduler.getPendingAcquireCount()).toBe(0);
    expect(a!.inFlight).toBe(1);
  });

  it('times out a queued acquire when capacity does not recover', async () => {
    const config: Config = {
      ...baseConfig,
      concurrency: { acquireTimeoutMs: 1, maxPendingRequests: 1 },
      upstreams: [{ id: 'a', baseUrl: 'https://a.example.com', apiKey: 'a', maxConcurrentRequests: 1 }]
    };
    const pool = new UpstreamPool(config);
    const scheduler = new Scheduler(config, pool);
    const [a] = pool.getAll();

    expect(pool.reserve(a!)).toBe(true);

    await expect(scheduler.acquireUpstream()).resolves.toBeNull();
    expect(scheduler.getPendingAcquireCount()).toBe(0);
  });

  it('rejects acquires when the pending queue is full', async () => {
    const config: Config = {
      ...baseConfig,
      concurrency: { acquireTimeoutMs: 20, maxPendingRequests: 0 },
      upstreams: [{ id: 'a', baseUrl: 'https://a.example.com', apiKey: 'a', maxConcurrentRequests: 1 }]
    };
    const pool = new UpstreamPool(config);
    const scheduler = new Scheduler(config, pool);
    const [a] = pool.getAll();

    expect(pool.reserve(a!)).toBe(true);

    await expect(scheduler.acquireUpstream()).rejects.toThrow('Upstream admission queue is full');
  });
});
