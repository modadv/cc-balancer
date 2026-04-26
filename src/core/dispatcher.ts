import { request } from 'undici';

import type { Config, ErrorType, ProxyRequestData, RequestAttemptContext, UpstreamState } from './types.js';
import { Scheduler } from './scheduler.js';
import { UpstreamPool } from './upstreamPool.js';
import { shouldRetrySameUpstream, waitForRetry } from './retry.js';
import { UpstreamUnavailableError } from '../utils/errors.js';

type DispatchLogger = {
  debug?: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

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

function releaseWhenBodyEnds(
  body: NodeJS.ReadableStream | null | undefined,
  release: () => void,
  onRelease?: (event: string) => void
): NodeJS.ReadableStream | null {
  if (!body) {
    release();
    onRelease?.('no-body');
    return null;
  }

  let released = false;
  const releaseOnce = (releaseEvent: string) => {
    if (released) {
      return;
    }

    released = true;
    release();
    onRelease?.(releaseEvent);
  };

  body.once('end', () => releaseOnce('body-end'));
  body.once('error', () => releaseOnce('body-error'));
  body.once('close', () => releaseOnce('body-close'));

  return body;
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

  async dispatch(requestData: ProxyRequestData, requestId: string, logger: DispatchLogger): Promise<{
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
    logger.info(
      {
        method: requestData.method,
        path: requestData.path,
        hasQueryString: requestData.queryString.length > 0,
        maxAttempts: this.config.retry.maxAttempts
      },
      'proxy dispatch started'
    );

    let lastRetriableFailure = false;
    let sendAttempt = 0;

    while (context.totalAttempts < this.config.retry.maxAttempts) {
      const acquireStartedAt = Date.now();
      const upstream = await this.scheduler.acquireUpstream(context.triedUpstreamIds, requestData.signal, requestId);

      if (!upstream) {
        logger.warn(
          {
            triedUpstreamIds: context.triedUpstreamIds,
            totalAttempts: context.totalAttempts,
            elapsedMs: Date.now() - context.startedAt
          },
          lastRetriableFailure ? 'all upstream attempts failed during acquisition' : 'no upstream capacity available'
        );
        throw new UpstreamUnavailableError(
          lastRetriableFailure ? 'All upstream attempts failed' : 'No available upstreams',
          lastRetriableFailure ? 502 : 503
        );
      }

      context.totalAttempts += 1;
      context.triedUpstreamIds.push(upstream.id);

      logger.info(
        {
          upstreamId: upstream.id,
          baseUrl: upstream.baseUrl,
          attempt: context.totalAttempts,
          acquireWaitMs: Date.now() - acquireStartedAt,
          inFlight: upstream.inFlight,
          maxConcurrentRequests: upstream.maxConcurrentRequests
        },
        'dispatching request to upstream'
      );

      const sameUpstreamBudget = Math.max(this.config.retry.perUpstreamRetries, 0);

      for (let sameUpstreamAttempt = 0; sameUpstreamAttempt <= sameUpstreamBudget; sameUpstreamAttempt += 1) {
        try {
          if (sameUpstreamAttempt > 0) {
            logger.debug?.(
              {
                upstreamId: upstream.id,
                attempt: context.totalAttempts,
                sameUpstreamAttempt
              },
              'waiting before same-upstream retry'
            );
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
            logger.info(
              {
                upstreamId: upstream.id,
                statusCode: response.statusCode,
                attempt: context.totalAttempts,
                sameUpstreamAttempt,
                elapsedMs: Date.now() - context.startedAt
              },
              'upstream request succeeded'
            );

            return {
              statusCode: response.statusCode,
              headers: response.headers,
              body: releaseWhenBodyEnds(
                response.body,
                () => this.upstreamPool.release(upstream),
                (releaseEvent) => {
                  logger.debug?.(
                    { upstreamId: upstream.id, releaseEvent, inFlight: upstream.inFlight },
                    'upstream lease released'
                  );
                }
              ),
              upstreamId: upstream.id
            };
          }

          if (!isRetriableStatus(response.statusCode)) {
            logger.info(
              {
                upstreamId: upstream.id,
                statusCode: response.statusCode,
                errorType: classifyResponse(response.statusCode),
                attempt: context.totalAttempts,
                elapsedMs: Date.now() - context.startedAt
              },
              'returning non-retriable upstream response'
            );
            return {
              statusCode: response.statusCode,
              headers: response.headers,
              body: releaseWhenBodyEnds(
                response.body,
                () => this.upstreamPool.release(upstream),
                (releaseEvent) => {
                  logger.debug?.(
                    { upstreamId: upstream.id, releaseEvent, inFlight: upstream.inFlight },
                    'upstream lease released'
                  );
                }
              ),
              upstreamId: upstream.id
            };
          }

          const errorType = classifyResponse(response.statusCode);

          if (errorType === 'server-error' && sameUpstreamAttempt < sameUpstreamBudget && shouldRetrySameUpstream(response.statusCode)) {
            await response.body.dump().catch(() => {});
            logger.warn(
              { upstreamId: upstream.id, attempt: context.totalAttempts, statusCode: response.statusCode, retryAttempt: sameUpstreamAttempt + 1 },
              'retrying same upstream after retriable server error'
            );
            continue;
          }

          await response.body.dump().catch(() => {});
          markFailureByType(this.config, this.upstreamPool, upstream, errorType);
          this.upstreamPool.release(upstream);
          lastRetriableFailure = true;

          logger.warn(
            {
              upstreamId: upstream.id,
              attempt: context.totalAttempts,
              statusCode: response.statusCode,
              errorType,
              availableAt: upstream.availableAt,
              cooldownMs: Math.max(0, upstream.availableAt - Date.now()),
              elapsedMs: Date.now() - context.startedAt
            },
            'upstream failed, moving to next upstream'
          );
          break;
        } catch (error) {
          const isRetryableNetworkError = sameUpstreamAttempt < sameUpstreamBudget;

          if (isRetryableNetworkError) {
            logger.warn(
              { upstreamId: upstream.id, attempt: context.totalAttempts, retryAttempt: sameUpstreamAttempt + 1, error },
              'network error, retrying same upstream'
            );
            await waitForRetry(this.config, sameUpstreamAttempt + 1);
            continue;
          }

          markFailureByType(this.config, this.upstreamPool, upstream, 'network-error');
          this.upstreamPool.release(upstream);
          lastRetriableFailure = true;

          logger.warn(
            {
              upstreamId: upstream.id,
              attempt: context.totalAttempts,
              error,
              availableAt: upstream.availableAt,
              cooldownMs: Math.max(0, upstream.availableAt - Date.now()),
              elapsedMs: Date.now() - context.startedAt
            },
            'network error, switching upstream'
          );
          break;
        }
      }
    }

    this.upstreamPool.markTerminalFailure();
    logger.error(
      {
        triedUpstreamIds: context.triedUpstreamIds,
        totalAttempts: context.totalAttempts,
        elapsedMs: Date.now() - context.startedAt
      },
      'request exhausted retry budget'
    );
    throw new UpstreamUnavailableError(lastRetriableFailure ? 'All upstream attempts failed' : 'No available upstreams', lastRetriableFailure ? 502 : 503);
  }
}
