import { z } from 'zod';

import { DEFAULT_CONFIG } from './defaults.js';
import type { Config } from '../core/types.js';

const upstreamSchema = z.object({
  id: z.string().min(1, 'upstream id is required'),
  baseUrl: z.url('upstream baseUrl must be a valid URL'),
  apiKey: z.string().min(1, 'upstream apiKey is required'),
  weight: z.number().int().positive().default(1)
});

const configSchema = z
  .object({
    server: z.object({
      host: z.string().min(1).default(DEFAULT_CONFIG.server.host),
      port: z.number().int().min(1).max(65535).default(DEFAULT_CONFIG.server.port)
    }),
    gateway: z
      .object({
        authToken: z.string().min(1, 'gateway authToken cannot be empty').optional()
      })
      .default(DEFAULT_CONFIG.gateway),
    log: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']).default(DEFAULT_CONFIG.log.level)
      })
      .default(DEFAULT_CONFIG.log),
    routing: z
      .object({
        strategy: z.enum(['round-robin', 'random', 'least-fail', 'weighted']).default(DEFAULT_CONFIG.routing.strategy)
      })
      .default(DEFAULT_CONFIG.routing),
    upstreams: z.array(upstreamSchema).min(1, 'at least one upstream is required'),
    retry: z
      .object({
        maxAttempts: z.number().int().nonnegative().optional(),
        perUpstreamRetries: z.number().int().nonnegative().default(DEFAULT_CONFIG.retry.perUpstreamRetries),
        backoff: z
          .object({
            type: z.enum(['fixed', 'exponential']).default(DEFAULT_CONFIG.retry.backoff.type),
            baseDelayMs: z.number().int().nonnegative().default(DEFAULT_CONFIG.retry.backoff.baseDelayMs),
            maxDelayMs: z.number().int().nonnegative().default(DEFAULT_CONFIG.retry.backoff.maxDelayMs)
          })
          .default(DEFAULT_CONFIG.retry.backoff)
      })
      .default({
        perUpstreamRetries: DEFAULT_CONFIG.retry.perUpstreamRetries,
        backoff: DEFAULT_CONFIG.retry.backoff
      }),
    cooldown: z
      .object({
        rateLimit: z.number().int().nonnegative().default(DEFAULT_CONFIG.cooldown.rateLimit),
        quotaExceeded: z.number().int().nonnegative().default(DEFAULT_CONFIG.cooldown.quotaExceeded),
        serverError: z.number().int().nonnegative().default(DEFAULT_CONFIG.cooldown.serverError),
        networkError: z.number().int().nonnegative().default(DEFAULT_CONFIG.cooldown.networkError)
      })
      .default(DEFAULT_CONFIG.cooldown),
    health: z
      .object({
        enable: z.boolean().default(DEFAULT_CONFIG.health.enable),
        path: z.string().min(1).default(DEFAULT_CONFIG.health.path)
      })
      .default(DEFAULT_CONFIG.health),
    metrics: z
      .object({
        enable: z.boolean().default(DEFAULT_CONFIG.metrics.enable),
        path: z.string().min(1).default(DEFAULT_CONFIG.metrics.path)
      })
      .default(DEFAULT_CONFIG.metrics),
    status: z
      .object({
        enable: z.boolean().default(DEFAULT_CONFIG.status.enable),
        path: z.string().min(1).default(DEFAULT_CONFIG.status.path)
      })
      .default(DEFAULT_CONFIG.status)
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();

    value.upstreams.forEach((upstream, index) => {
      if (ids.has(upstream.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['upstreams', index, 'id'],
          message: `duplicate upstream id: ${upstream.id}`
        });
        return;
      }
      ids.add(upstream.id);
    });
  });

export function parseConfig(rawConfig: unknown): Config {
  const parsed = configSchema.safeParse(rawConfig);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }

  const maxAttempts = parsed.data.retry.maxAttempts ?? parsed.data.upstreams.length;

  return {
    ...parsed.data,
    retry: {
      ...parsed.data.retry,
      maxAttempts
    }
  };
}
