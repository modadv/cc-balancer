import type { BackoffType } from '../core/types.js';

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateBackoffDelay(type: BackoffType, attemptNumber: number, baseDelayMs: number, maxDelayMs: number): number {
  if (attemptNumber <= 0) {
    return 0;
  }

  if (type === 'fixed') {
    return Math.min(baseDelayMs, maxDelayMs);
  }

  return Math.min(baseDelayMs * 2 ** (attemptNumber - 1), maxDelayMs);
}
