import pino from 'pino';

import type { LogLevel } from '../core/types.js';

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.x-api-key',
  'headers.authorization',
  'headers.x-api-key',
  '*.apiKey',
  '*.authToken'
];

export function createLogger(level: LogLevel) {
  return pino({
    level,
    redact: LOG_REDACT_PATHS,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  });
}
