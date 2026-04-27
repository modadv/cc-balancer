import type { Readable } from 'node:stream';

import type { FastifyBaseLogger } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type RoutingStrategy = 'round-robin' | 'random' | 'least-fail' | 'weighted';
export type BackoffType = 'fixed' | 'exponential';

export type UpstreamConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  weight?: number;
  maxConcurrentRequests?: number;
};

export type Config = {
  server: {
    host: string;
    port: number;
  };
  gateway: {
    authToken?: string;
  };
  log: {
    level: LogLevel;
  };
  routing: {
    strategy: RoutingStrategy;
  };
  concurrency: {
    acquireTimeoutMs: number;
    maxPendingRequests: number;
  };
  requestTimeout: {
    headersMs: number;
    bodyMs: number;
  };
  upstreams: UpstreamConfig[];
  retry: {
    maxAttempts: number;
    perUpstreamRetries: number;
    backoff: {
      type: BackoffType;
      baseDelayMs: number;
      maxDelayMs: number;
    };
  };
  cooldown: {
    rateLimit: number;
    quotaExceeded: number;
    serverError: number;
    networkError: number;
  };
  health: {
    enable: boolean;
    path: string;
  };
  metrics: {
    enable: boolean;
    path: string;
  };
  status: {
    enable: boolean;
    path: string;
  };
};

export type UpstreamState = {
  id: string;
  baseUrl: string;
  apiKey: string;
  weight: number;
  availableAt: number;
  lastUsedAt: number | null;
  inFlight: number;
  maxConcurrentRequests: number | null;
  successCount: number;
  failCount: number;
  rateLimitCount: number;
  quotaExceededCount: number;
  serverErrorCount: number;
  networkErrorCount: number;
  consecutiveFailures: number;
};

export type UpstreamSnapshot = Omit<UpstreamState, 'apiKey'> & {
  available: boolean;
};

export type RequestAttemptContext = {
  requestId: string;
  startedAt: number;
  totalAttempts: number;
  triedUpstreamIds: string[];
};

export type ProxyRequestData = {
  method: string;
  path: string;
  queryString: string;
  headers: Record<string, string | string[] | undefined>;
  signal?: AbortSignal;
  getBody: (sendAttempt: number) => Promise<Buffer | Readable | undefined>;
};

export type ErrorType =
  | 'rate-limit'
  | 'quota-exceeded'
  | 'server-error'
  | 'network-error'
  | 'client-error'
  | 'unknown';

export type AttemptDecision =
  | {
      outcome: 'success';
      upstreamId: string;
      statusCode: number;
      headers: IncomingHttpHeaders;
      body: Readable | null;
    }
  | {
      outcome: 'return';
      upstreamId: string;
      statusCode: number;
      headers: IncomingHttpHeaders;
      body: Readable | null;
      errorType: ErrorType;
    }
  | {
      outcome: 'retry';
      upstreamId: string;
      errorType: ErrorType;
      statusCode?: number;
      reason: string;
    };

export type GatewayMetrics = {
  totalRequests: number;
  totalSuccess: number;
  totalFail: number;
  upstreamSuccessById: Record<string, number>;
  upstreamFailById: Record<string, number>;
  upstreamCooldownCount: Record<string, number>;
};

export type GatewayServices = {
  config: Config;
  logger: FastifyBaseLogger;
};
