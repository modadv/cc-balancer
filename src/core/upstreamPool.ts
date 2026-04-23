import type { Config, GatewayMetrics, UpstreamConfig, UpstreamSnapshot, UpstreamState } from './types.js';

function createState(upstream: UpstreamConfig): UpstreamState {
  return {
    id: upstream.id,
    baseUrl: upstream.baseUrl.replace(/\/+$/, ''),
    apiKey: upstream.apiKey,
    weight: upstream.weight ?? 1,
    availableAt: 0,
    lastUsedAt: null,
    successCount: 0,
    failCount: 0,
    rateLimitCount: 0,
    quotaExceededCount: 0,
    serverErrorCount: 0,
    networkErrorCount: 0,
    consecutiveFailures: 0
  };
}

export class UpstreamPool {
  readonly #states: UpstreamState[];
  readonly #metrics: GatewayMetrics;
  #roundRobinIndex = 0;

  constructor(config: Config) {
    this.#states = config.upstreams.map((upstream) => createState(upstream));
    this.#metrics = {
      totalRequests: 0,
      totalSuccess: 0,
      totalFail: 0,
      upstreamSuccessById: Object.fromEntries(this.#states.map((state) => [state.id, 0])),
      upstreamFailById: Object.fromEntries(this.#states.map((state) => [state.id, 0])),
      upstreamCooldownCount: Object.fromEntries(this.#states.map((state) => [state.id, 0]))
    };
  }

  getAvailable(now: number = Date.now()): UpstreamState[] {
    return this.#states.filter((state) => state.availableAt <= now);
  }

  getAll(): UpstreamState[] {
    return this.#states;
  }

  markAttempt(): void {
    this.#metrics.totalRequests += 1;
  }

  touch(state: UpstreamState, now: number = Date.now()): void {
    state.lastUsedAt = now;
  }

  markSuccess(state: UpstreamState, now: number = Date.now()): void {
    state.successCount += 1;
    state.consecutiveFailures = 0;
    state.lastUsedAt = now;
    this.#metrics.totalSuccess += 1;
    this.#metrics.upstreamSuccessById[state.id] += 1;
  }

  markFailure(state: UpstreamState, now: number = Date.now()): void {
    state.failCount += 1;
    state.consecutiveFailures += 1;
    state.lastUsedAt = now;
    this.#metrics.totalFail += 1;
    this.#metrics.upstreamFailById[state.id] += 1;
  }

  applyCooldown(state: UpstreamState, durationSeconds: number, now: number = Date.now()): void {
    state.availableAt = now + durationSeconds * 1000;
    this.#metrics.upstreamCooldownCount[state.id] += 1;
  }

  markRateLimit(state: UpstreamState): void {
    state.rateLimitCount += 1;
  }

  markQuotaExceeded(state: UpstreamState): void {
    state.quotaExceededCount += 1;
  }

  markServerError(state: UpstreamState): void {
    state.serverErrorCount += 1;
  }

  markNetworkError(state: UpstreamState): void {
    state.networkErrorCount += 1;
  }

  nextRoundRobinIndex(size: number): number {
    const index = this.#roundRobinIndex % size;
    this.#roundRobinIndex += 1;
    return index;
  }

  markTerminalFailure(): void {
    this.#metrics.totalFail += 1;
  }

  getMetrics() {
    return {
      ...this.#metrics,
      currentAvailableUpstreams: this.getAvailable().length
    };
  }

  getStatusSnapshots(now: number = Date.now()): UpstreamSnapshot[] {
    return this.#states.map((state) => ({
      id: state.id,
      baseUrl: state.baseUrl,
      weight: state.weight,
      availableAt: state.availableAt,
      available: state.availableAt <= now,
      lastUsedAt: state.lastUsedAt,
      successCount: state.successCount,
      failCount: state.failCount,
      rateLimitCount: state.rateLimitCount,
      quotaExceededCount: state.quotaExceededCount,
      serverErrorCount: state.serverErrorCount,
      networkErrorCount: state.networkErrorCount,
      consecutiveFailures: state.consecutiveFailures
    }));
  }
}
