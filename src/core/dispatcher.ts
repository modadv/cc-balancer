import { request } from 'undici';

import type { Config, ErrorType, ProxyRequestData, RequestAttemptContext, UpstreamState } from './types.js';
import { Scheduler } from './scheduler.js';
import { UpstreamPool } from './upstreamPool.js';
import { shouldRetrySameUpstream, waitForRetry } from './retry.js';
import { UpstreamUnavailableError } from '../utils/errors.js';

function buildTargetUrl(baseUrl: string, requestData: ProxyRequestData): string {
  return `${baseUrl}${requestData.path}${requestData.queryString ? `?${requestData.queryString}` : ''}`;
}

const STRIP_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key'
]);

function createHeaders(inputHeaders: ProxyRequestData['headers'], apiKey: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  let hasAnthropicVersion = false;

  for (const [key, value] of Object.entries(inputHeaders)) {
    const lowerKey = key.toLowerCase();

    if (STRIP_REQUEST_HEADERS.has(lowerKey) || value === undefined) {
      continue;
    }

    if (lowerKey === 'anthropic-version') {
      hasAnthropicVersion = true;
    }

    if (Array.isArray(value)) {
      headers[key] = value;
      continue;
    }

    headers[key] = value;
  }

  headers['x-api-key'] = apiKey;

  if (!hasAnthropicVersion) {
    headers['anthropic-version'] = '2023-06-01';
  }

  return headers;
}

function classifyResponse(statusCode: number): ErrorType {
  if (statusCode === 429) {
    return 'rate-limit';
  }

  if (statusCode === 403) {
    return 'quota-exceeded';
  }

  if (statusCode >= 500) {
    return 'server-error';
  }

  if (statusCode >= 400) {
    return 'client-error';
  }

  return 'unknown';
}

function isRetriableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode === 403 || statusCode >= 500;
}

function markFailureByType(config: Config, upstreamPool: UpstreamPool, upstream: UpstreamState, errorType: ErrorType): void {
  upstreamPool.markFailure(upstream);

  switch (errorType) {
    case 'rate-limit':
      upstreamPool.markRateLimit(upstream);
      upstreamPool.applyCooldown(upstream, config.cooldown.rateLimit);
      return;
    case 'quota-exceeded':
      upstreamPool.markQuotaExceeded(upstream);
      upstreamPool.applyCooldown(upstream, config.cooldown.quotaExceeded);
      return;
    case 'server-error':
      upstreamPool.markServerError(upstream);
      upstreamPool.applyCooldown(upstream, config.cooldown.serverError);
      return;
    case 'network-error':
      upstreamPool.markNetworkError(upstream);
      upstreamPool.applyCooldown(upstream, config.cooldown.networkError);
      return;
    default:
      return;
  }
}

export class Dispatcher {
  constructor(
    private readonly config: Config,
    private readonly scheduler: Scheduler,
    private readonly upstreamPool: UpstreamPool
  ) {}

  async dispatch(requestData: ProxyRequestData, requestId: string, logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void; }): Promise<{
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      body: NodeJS.ReadableStream | null;
      upstreamId: string;
  }> {
    const context: RequestAttemptContext = {
      requestId,
      startedAt: Date.now(),
      totalAttempts: 0,
      triedUpstreamIds: []
    };

    this.upstreamPool.markAttempt();

    let lastRetriableFailure = false;
    let sendAttempt = 0;

    while (context.totalAttempts < this.config.retry.maxAttempts) {
      const upstream = this.scheduler.selectUpstream(context.triedUpstreamIds);

      if (!upstream) {
        throw new UpstreamUnavailableError(
          lastRetriableFailure ? 'All upstream attempts failed' : 'No available upstreams',
          lastRetriableFailure ? 502 : 503
        );
      }

      context.totalAttempts += 1;
      context.triedUpstreamIds.push(upstream.id);

      logger.info({ requestId, upstreamId: upstream.id, attempt: context.totalAttempts }, 'dispatching request to upstream');

      const sameUpstreamBudget = Math.max(this.config.retry.perUpstreamRetries, 0);

      for (let sameUpstreamAttempt = 0; sameUpstreamAttempt <= sameUpstreamBudget; sameUpstreamAttempt += 1) {
        try {
          if (sameUpstreamAttempt > 0) {
            await waitForRetry(this.config, sameUpstreamAttempt);
          }

          const requestBody = await requestData.getBody(sendAttempt);
          sendAttempt += 1;

          const response = await request(buildTargetUrl(upstream.baseUrl, requestData), {
            method: requestData.method,
            headers: createHeaders(requestData.headers, upstream.apiKey),
            body: requestBody,
            signal: requestData.signal,
            headersTimeout: 30_000,
            bodyTimeout: 0
          });

          this.upstreamPool.touch(upstream);

          if (response.statusCode >= 200 && response.statusCode < 300) {
            this.upstreamPool.markSuccess(upstream);

            return {
              statusCode: response.statusCode,
              headers: response.headers,
              body: response.body ?? null,
              upstreamId: upstream.id
            };
          }

          if (!isRetriableStatus(response.statusCode)) {
            return {
              statusCode: response.statusCode,
              headers: response.headers,
              body: response.body ?? null,
              upstreamId: upstream.id
            };
          }

          const errorType = classifyResponse(response.statusCode);

          if (errorType === 'server-error' && sameUpstreamAttempt < sameUpstreamBudget && shouldRetrySameUpstream(response.statusCode)) {
            await response.body.dump().catch(() => {});
            logger.warn(
              { requestId, upstreamId: upstream.id, attempt: context.totalAttempts, statusCode: response.statusCode, retryAttempt: sameUpstreamAttempt + 1 },
              'retrying same upstream after retriable server error'
            );
            continue;
          }

          await response.body.dump().catch(() => {});
          markFailureByType(this.config, this.upstreamPool, upstream, errorType);
          lastRetriableFailure = true;

          logger.warn(
            { requestId, upstreamId: upstream.id, attempt: context.totalAttempts, statusCode: response.statusCode, errorType },
            'upstream failed, moving to next upstream'
          );
          break;
        } catch (error) {
          const isRetryableNetworkError = sameUpstreamAttempt < sameUpstreamBudget;

          if (isRetryableNetworkError) {
            logger.warn(
              { requestId, upstreamId: upstream.id, attempt: context.totalAttempts, retryAttempt: sameUpstreamAttempt + 1, error },
              'network error, retrying same upstream'
            );
            await waitForRetry(this.config, sameUpstreamAttempt + 1);
            continue;
          }

          markFailureByType(this.config, this.upstreamPool, upstream, 'network-error');
          lastRetriableFailure = true;

          logger.warn({ requestId, upstreamId: upstream.id, attempt: context.totalAttempts, error }, 'network error, switching upstream');
          break;
        }
      }
    }

    this.upstreamPool.markTerminalFailure();
    throw new UpstreamUnavailableError(lastRetriableFailure ? 'All upstream attempts failed' : 'No available upstreams', lastRetriableFailure ? 502 : 503);
  }
}
