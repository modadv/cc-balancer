import type { Config } from '../core/types.js';

export const DEFAULT_CONFIG = {
  server: {
    host: '0.0.0.0',
    port: 8000
  },
  gateway: {},
  log: {
    level: 'info'
  },
  routing: {
    strategy: 'least-fail'
  },
  retry: {
    maxAttempts: 0,
    perUpstreamRetries: 2,
    backoff: {
      type: 'exponential',
      baseDelayMs: 200,
      maxDelayMs: 2000
    }
  },
  cooldown: {
    rateLimit: 60,
    quotaExceeded: 300,
    serverError: 10,
    networkError: 15
  },
  health: {
    enable: true,
    path: '/health'
  },
  metrics: {
    enable: true,
    path: '/metrics'
  },
  status: {
    enable: true,
    path: '/upstreams'
  }
} as const satisfies Omit<Config, 'upstreams'>;
