import type { Config } from './types.js';
import { calculateBackoffDelay, sleep } from '../utils/backoff.js';

export function shouldRetrySameUpstream(statusCode?: number): boolean {
  if (statusCode === undefined) {
    return true;
  }

  return statusCode >= 500;
}

export async function waitForRetry(config: Config, attemptNumber: number): Promise<void> {
  const { type, baseDelayMs, maxDelayMs } = config.retry.backoff;
  const delay = calculateBackoffDelay(type, attemptNumber, baseDelayMs, maxDelayMs);
  await sleep(delay);
}
