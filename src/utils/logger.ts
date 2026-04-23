import pino from 'pino';

import type { LogLevel } from '../core/types.js';

export function createLogger(level: LogLevel) {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  });
}
