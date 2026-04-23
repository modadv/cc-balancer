import type { Config, UpstreamState } from './types.js';
import { UpstreamPool } from './upstreamPool.js';

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
  constructor(
    private readonly config: Config,
    private readonly upstreamPool: UpstreamPool
  ) {}

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
}
