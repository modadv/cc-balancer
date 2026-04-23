import { PassThrough, type Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { Dispatcher } from '../../core/dispatcher.js';
import { createRequestId } from '../../utils/requestId.js';
import { UpstreamUnavailableError } from '../../utils/errors.js';

type RawBodyRequest = FastifyRequest<{
  Body?: unknown;
}>;

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function setResponseHeaders(reply: FastifyReply, headers: IncomingHttpHeaders): void {
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lowerKey) || value === undefined) {
      continue;
    }

    reply.header(key, value);
  }
}

function requestCanHaveBody(method: string): boolean {
  return !['GET', 'HEAD'].includes(method.toUpperCase());
}

function requestHasStreamingBody(raw: IncomingMessage, method: string): boolean {
  if (!requestCanHaveBody(method)) {
    return false;
  }

  const contentLength = raw.headers['content-length'];
  if (contentLength !== undefined) {
    return Number(contentLength) > 0;
  }

  return raw.headers['transfer-encoding'] !== undefined;
}

function createReplayableRequestBody(raw: IncomingMessage, method: string): { signal: AbortSignal; getBody: (sendAttempt: number) => Promise<Buffer | Readable | undefined>; } {
  const abortController = new AbortController();

  raw.once('aborted', () => {
    abortController.abort(new Error('Client aborted request.'));
  });

  raw.once('close', () => {
    if (raw.destroyed && !raw.complete) {
      abortController.abort(new Error('Client connection closed before request body completed.'));
    }
  });

  if (!requestHasStreamingBody(raw, method)) {
    return {
      signal: abortController.signal,
      getBody: async () => undefined
    };
  }

  const liveStream = new PassThrough();
  const bufferedChunks: Buffer[] = [];

  const capturedBody = new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bufferedChunks.push(bufferChunk);

      if (!liveStream.write(bufferChunk)) {
        raw.pause();
      }
    };

    const onDrain = () => {
      raw.resume();
    };

    const finalize = () => {
      raw.off('data', onData);
      liveStream.off('drain', onDrain);
    };

    raw.on('data', onData);
    liveStream.on('drain', onDrain);

    raw.once('end', () => {
      finalize();
      liveStream.end();
      resolve(Buffer.concat(bufferedChunks));
    });

    raw.once('error', (error) => {
      finalize();
      liveStream.destroy(error);
      reject(error);
    });

    raw.once('aborted', () => {
      const error = new Error('Client aborted request body.');
      finalize();
      liveStream.destroy(error);
      reject(error);
    });
  });

  return {
    signal: abortController.signal,
    getBody: async (sendAttempt: number) => {
      if (sendAttempt === 0) {
        return liveStream;
      }

      return capturedBody;
    }
  };
}

export async function registerProxyRoutes(app: FastifyInstance, dispatcher: Dispatcher): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (request, payload, done) => {
    done(null, payload);
  });

  app.route({
    method: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
    url: '/*',
    handler: async (request: RawBodyRequest, reply: FastifyReply) => {
      const requestId = createRequestId();
      const logger = request.log.child({ requestId });
      const bodySource = createReplayableRequestBody(request.raw, request.method);

      try {
        const { statusCode, headers, body, upstreamId } = await dispatcher.dispatch(
          {
            method: request.method,
            path: request.raw.url?.split('?')[0] ?? request.url,
            queryString: request.raw.url?.split('?')[1] ?? '',
            headers: request.headers,
            signal: bodySource.signal,
            getBody: bodySource.getBody
          },
          requestId,
          logger
        );

        reply.code(statusCode);
        reply.header('x-request-id', requestId);
        reply.header('x-upstream-id', upstreamId);
        setResponseHeaders(reply, headers);

        return reply.send(body);
      } catch (error) {
        if (error instanceof UpstreamUnavailableError) {
          request.log.error({ requestId, error }, 'request failed after exhausting upstreams');
          reply.code(error.statusCode).header('x-request-id', requestId);
          return {
            error: error.message
          };
        }

        request.log.error({ requestId, error }, 'unexpected proxy failure');
        reply.code(500).header('x-request-id', requestId);
        return {
          error: 'Internal gateway error'
        };
      }
    }
  });
}
