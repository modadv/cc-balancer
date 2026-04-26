import type { Config, UpstreamState } from './types.js';
import { UpstreamPool } from './upstreamPool.js';
import { UpstreamUnavailableError } from '../utils/errors.js';

type PendingAcquire = {
  requestId?: string;
  excludedIds: string[];
  queuedAt: number;
  resolve: (state: UpstreamState | null) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
};

type SchedulerLogger = {
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

function pickWeighted(states: UpstreamState[]): UpstreamState {
  const totalWeight = states.reduce((sum, state) => sum + state.weight, 0);
  let remaining = Math.random() * totalWeight;

  for (const state of states) {
    remaining -= state.weight;
    if (remaining <= 0) {
      return state;
    }
  }

  return states[states.length - 1]!;
}

export class Scheduler {
  readonly #pendingAcquires: PendingAcquire[] = [];
  #cooldownWakeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly upstreamPool: UpstreamPool,
    private readonly logger?: SchedulerLogger
  ) {
    this.upstreamPool.onStateChange(() => {
      this.drainPendingAcquires();
    });
  }

  selectUpstream(excludedIds: string[] = [], now: number = Date.now()): UpstreamState | null {
    const candidates = this.upstreamPool
      .getAvailable(now)
      .filter((state) => !excludedIds.includes(state.id));

    if (candidates.length === 0) {
      return null;
    }

    switch (this.config.routing.strategy) {
      case 'round-robin':
        return candidates[this.upstreamPool.nextRoundRobinIndex(candidates.length)] ?? null;
      case 'random':
        return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
      case 'weighted':
        return pickWeighted(candidates);
      case 'least-fail':
      default:
        return [...candidates].sort((left, right) => {
          if (left.inFlight !== right.inFlight) {
            return left.inFlight - right.inFlight;
          }

          if (left.consecutiveFailures !== right.consecutiveFailures) {
            return left.consecutiveFailures - right.consecutiveFailures;
          }

          if (left.failCount !== right.failCount) {
            return left.failCount - right.failCount;
          }

          const leftLastUsed = left.lastUsedAt ?? 0;
          const rightLastUsed = right.lastUsedAt ?? 0;

          if (leftLastUsed !== rightLastUsed) {
            return leftLastUsed - rightLastUsed;
          }

          return left.id.localeCompare(right.id);
        })[0]!;
    }
  }

  async acquireUpstream(excludedIds: string[] = [], signal?: AbortSignal, requestId?: string): Promise<UpstreamState | null> {
    const upstream = this.tryReserveUpstream(excludedIds);

    if (upstream || this.config.concurrency.acquireTimeoutMs === 0) {
      if (upstream) {
        this.logger?.debug?.(
          { requestId, upstreamId: upstream.id, inFlight: upstream.inFlight, excludedIds },
          'upstream acquired without queueing'
        );
      }
      return upstream;
    }

    const excludedIdSet = new Set(excludedIds);
    if (this.upstreamPool.getAll().every((state) => excludedIdSet.has(state.id))) {
      return null;
    }

    if (this.#pendingAcquires.length >= this.config.concurrency.maxPendingRequests) {
      this.logger?.warn?.(
        {
          pendingAcquireRequests: this.#pendingAcquires.length,
          maxPendingRequests: this.config.concurrency.maxPendingRequests,
          requestId,
          excludedIds
        },
        'upstream admission queue full'
      );
      throw new UpstreamUnavailableError('Upstream admission queue is full', 503);
    }

    if (signal?.aborted) {
      return null;
    }

    return new Promise<UpstreamState | null>((resolve) => {
      const pending: PendingAcquire = {
        requestId,
        excludedIds,
        queuedAt: Date.now(),
        resolve,
        timer: setTimeout(() => {
          this.removePendingAcquire(pending);
          this.logger?.warn?.(
            {
              pendingAcquireRequests: this.#pendingAcquires.length,
              acquireTimeoutMs: this.config.concurrency.acquireTimeoutMs,
              requestId: pending.requestId,
              excludedIds: pending.excludedIds,
              queuedMs: Date.now() - pending.queuedAt
            },
            'upstream acquisition timed out'
          );
          resolve(null);
        }, this.config.concurrency.acquireTimeoutMs),
        signal
      };

      pending.timer.unref?.();

      if (signal) {
        pending.onAbort = () => {
          this.removePendingAcquire(pending);
          this.logger?.debug?.(
            {
              pendingAcquireRequests: this.#pendingAcquires.length,
              requestId: pending.requestId,
              excludedIds: pending.excludedIds,
              queuedMs: Date.now() - pending.queuedAt
            },
            'upstream acquisition aborted'
          );
          resolve(null);
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }

      this.#pendingAcquires.push(pending);
      this.logger?.debug?.(
        {
          pendingAcquireRequests: this.#pendingAcquires.length,
          acquireTimeoutMs: this.config.concurrency.acquireTimeoutMs,
          requestId,
          excludedIds
        },
        'request queued for upstream capacity'
      );
      this.scheduleCooldownWake();
    });
  }

  getPendingAcquireCount(): number {
    return this.#pendingAcquires.length;
  }

  private tryReserveUpstream(excludedIds: string[]): UpstreamState | null {
    const attemptedIds = new Set(excludedIds);

    while (attemptedIds.size < this.upstreamPool.getAll().length) {
      const upstream = this.selectUpstream([...attemptedIds]);

      if (!upstream) {
        return null;
      }

      if (this.upstreamPool.reserve(upstream)) {
        return upstream;
      }

      attemptedIds.add(upstream.id);
    }

    return null;
  }

  private drainPendingAcquires(): void {
    for (const pending of [...this.#pendingAcquires]) {
      if (pending.signal?.aborted) {
        this.removePendingAcquire(pending);
        pending.resolve(null);
        continue;
      }

      const upstream = this.tryReserveUpstream(pending.excludedIds);
      if (!upstream) {
        continue;
      }

      this.removePendingAcquire(pending);
      this.logger?.debug?.(
        {
          upstreamId: upstream.id,
          inFlight: upstream.inFlight,
          pendingAcquireRequests: this.#pendingAcquires.length,
          queuedMs: Date.now() - pending.queuedAt,
          requestId: pending.requestId,
          excludedIds: pending.excludedIds
        },
        'queued request acquired upstream capacity'
      );
      pending.resolve(upstream);
    }

    this.scheduleCooldownWake();
  }

  private removePendingAcquire(pending: PendingAcquire): void {
    const index = this.#pendingAcquires.indexOf(pending);
    if (index >= 0) {
      this.#pendingAcquires.splice(index, 1);
    }

    clearTimeout(pending.timer);

    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
  }

  private scheduleCooldownWake(): void {
    if (this.#cooldownWakeTimer) {
      clearTimeout(this.#cooldownWakeTimer);
      this.#cooldownWakeTimer = null;
    }

    if (this.#pendingAcquires.length === 0) {
      return;
    }

    const now = Date.now();
    const nextAvailableAt = this.upstreamPool
      .getAll()
      .filter((state) => this.upstreamPool.hasCapacity(state) && state.availableAt > now)
      .reduce<number | null>((earliest, state) => (earliest === null ? state.availableAt : Math.min(earliest, state.availableAt)), null);

    if (nextAvailableAt === null) {
      return;
    }

    this.#cooldownWakeTimer = setTimeout(() => {
      this.#cooldownWakeTimer = null;
      this.drainPendingAcquires();
    }, Math.max(0, nextAvailableAt - now));
    this.#cooldownWakeTimer.unref?.();
  }
}
