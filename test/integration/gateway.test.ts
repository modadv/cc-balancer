import Fastify from 'fastify';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetch, request } from 'undici';

import { createServer } from '../../src/server/createServer.js';
import type { Config } from '../../src/core/types.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function waitForExpectation(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

async function startUpstream(statusCode: number, body: unknown) {
  const app = Fastify();
  app.post('/v1/messages', async (_request, reply) => reply.code(statusCode).send(body));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();

  if (!address || typeof address === 'string') {
    throw new Error('failed to resolve upstream address');
  }

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

function createConfig(upstreams: Config['upstreams'], overrides?: Partial<Config>): Config {
  return {
    server: { host: '127.0.0.1', port: 0 },
    gateway: {},
    log: { level: 'error' },
    routing: { strategy: 'round-robin' },
    concurrency: { acquireTimeoutMs: 50, maxPendingRequests: 10 },
    requestTimeout: { headersMs: 30_000, bodyMs: 0 },
    upstreams,
    retry: {
      maxAttempts: 2,
      perUpstreamRetries: 0,
      backoff: { type: 'fixed', baseDelayMs: 1, maxDelayMs: 1 }
    },
    cooldown: {
      rateLimit: 60,
      quotaExceeded: 300,
      serverError: 10,
      networkError: 15
    },
    health: { enable: true, path: '/health' },
    metrics: { enable: true, path: '/metrics' },
    status: { enable: true, path: '/upstreams' },
    ...overrides
  };
}

describe('gateway integration', () => {
  const startedServers: Array<{ close: () => Promise<unknown> }> = [];

  beforeEach(() => {
    startedServers.length = 0;
  });

  afterEach(async () => {
    await Promise.all(startedServers.map((server) => server.close()));
  });

  it('fails over from a 429 upstream to a healthy upstream', async () => {
    const upstreamA = await startUpstream(429, { error: 'rate limited' });
    const upstreamB = await startUpstream(200, { ok: true });
    startedServers.push(upstreamA.app, upstreamB.app);

    const config = createConfig([
      { id: 'a', baseUrl: upstreamA.baseUrl, apiKey: 'key-a' },
      { id: 'b', baseUrl: upstreamB.baseUrl, apiKey: 'key-b' }
    ]);

    const gateway = await createServer(config);
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream-id')).toBe('b');
    await expect(response.json()).resolves.toEqual({ ok: true });

    const statusResponse = await fetch(`http://127.0.0.1:${address.port}/upstreams`);
    const statusJson = (await statusResponse.json()) as { upstreams: Array<{ id: string; available: boolean; rateLimitCount: number }> };
    const upstreamAStatus = statusJson.upstreams.find((upstream) => upstream.id === 'a');

    expect(upstreamAStatus).toMatchObject({
      available: false,
      rateLimitCount: 1
    });
  });

  it('fails over from a 402 daily quota upstream to a healthy upstream', async () => {
    const upstreamA = await startUpstream(402, {
      error: {
        type: 'rate_limit_error',
        message:
          '每日额度超限：当前 $100.1216 USD（限制：$100.0000 USD）。将于 2026-04-27T16:00:00.000Z 重置',
        code: 'rate_limit_exceeded',
        limit_type: 'daily_quota',
        current: 100.1216,
        limit: 100,
        reset_time: '2026-04-27T16:00:00.000Z'
      }
    });
    const upstreamB = await startUpstream(200, { ok: true });
    startedServers.push(upstreamA.app, upstreamB.app);

    const config = createConfig([
      { id: 'a', baseUrl: upstreamA.baseUrl, apiKey: 'key-a' },
      { id: 'b', baseUrl: upstreamB.baseUrl, apiKey: 'key-b' }
    ]);

    const gateway = await createServer(config);
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream-id')).toBe('b');
    await expect(response.json()).resolves.toEqual({ ok: true });

    const statusResponse = await fetch(`http://127.0.0.1:${address.port}/upstreams`);
    const statusJson = (await statusResponse.json()) as {
      upstreams: Array<{ id: string; available: boolean; quotaExceededCount: number }>;
    };
    const upstreamAStatus = statusJson.upstreams.find((upstream) => upstream.id === 'a');

    expect(upstreamAStatus).toMatchObject({
      available: false,
      quotaExceededCount: 1
    });
  });

  it('fails over from other 4xx upstream responses to a healthy upstream', async () => {
    const upstreamA = await startUpstream(400, { error: { type: 'invalid_request_error' } });
    const upstreamB = await startUpstream(200, { ok: true });
    startedServers.push(upstreamA.app, upstreamB.app);

    const config = createConfig([
      { id: 'a', baseUrl: upstreamA.baseUrl, apiKey: 'key-a' },
      { id: 'b', baseUrl: upstreamB.baseUrl, apiKey: 'key-b' }
    ]);

    const gateway = await createServer(config);
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-upstream-id')).toBe('b');
    await expect(response.json()).resolves.toEqual({ ok: true });

    const statusResponse = await fetch(`http://127.0.0.1:${address.port}/upstreams`);
    const statusJson = (await statusResponse.json()) as { upstreams: Array<{ id: string; failCount: number }> };
    const upstreamAStatus = statusJson.upstreams.find((upstream) => upstream.id === 'a');

    expect(upstreamAStatus).toMatchObject({
      failCount: 1
    });
  });

  it('returns 503 when every upstream is in cooldown before dispatch', async () => {
    const upstreamA = await startUpstream(429, { error: 'rate limited' });
    const upstreamB = await startUpstream(429, { error: 'still rate limited' });
    startedServers.push(upstreamA.app, upstreamB.app);

    const config = createConfig([
      { id: 'a', baseUrl: upstreamA.baseUrl, apiKey: 'key-a' },
      { id: 'b', baseUrl: upstreamB.baseUrl, apiKey: 'key-b' }
    ]);

    const gateway = await createServer(config);
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    const secondResponse = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(secondResponse.status).toBe(503);
    await expect(secondResponse.json()).resolves.toEqual({ error: 'No available upstreams' });
  });

  it('strips client auth headers before proxying upstream', async () => {
    const upstream = Fastify();
    upstream.post('/v1/messages', async (request) => ({
      authorization: request.headers.authorization ?? null,
      xApiKey: request.headers['x-api-key'] ?? null,
      anthropicVersion: request.headers['anthropic-version'] ?? null
    }));
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    startedServers.push(upstream);
    const upstreamAddress = upstream.server.address();

    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('failed to resolve upstream address');
    }

    const gateway = await createServer(
      createConfig([{ id: 'secure', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'upstream-secret' }])
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = gateway.server.address();

    if (!gatewayAddress || typeof gatewayAddress === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const response = await fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-token',
        'x-api-key': 'client-api-key',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authorization: null,
      xApiKey: 'upstream-secret',
      anthropicVersion: '2023-06-01'
    });
  });

  it('preserves compressed upstream response bytes and headers', async () => {
    const payload = Buffer.from('gateway-compressed-response');
    const compressedPayload = zlib.gzipSync(payload);
    const upstream = Fastify();
    upstream.get('/compressed', async (_request, reply) => {
      reply
        .code(200)
        .header('content-type', 'text/plain')
        .header('content-encoding', 'gzip')
        .header('content-length', String(compressedPayload.length));
      return reply.send(compressedPayload);
    });
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    startedServers.push(upstream);
    const upstreamAddress = upstream.server.address();

    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('failed to resolve upstream address');
    }

    const gateway = await createServer(
      createConfig([{ id: 'compressed', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'upstream-secret' }])
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = gateway.server.address();

    if (!gatewayAddress || typeof gatewayAddress === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const response = await request(`http://127.0.0.1:${gatewayAddress.port}/compressed`);
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk));
    }
    const proxiedBody = Buffer.concat(chunks);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['content-length']).toBe(String(compressedPayload.length));
    expect(proxiedBody.equals(compressedPayload)).toBe(true);
    expect(zlib.gunzipSync(proxiedBody).toString()).toBe(payload.toString());
  });

  it('requires a gateway bearer token when gateway auth is configured', async () => {
    const upstream = await startUpstream(200, { ok: true });
    startedServers.push(upstream.app);

    const gateway = await createServer(
      createConfig([{ id: 'auth', baseUrl: upstream.baseUrl, apiKey: 'upstream-secret' }], {
        gateway: { authToken: 'gateway-secret' }
      })
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toBe('Bearer');
    await expect(unauthorized.json()).resolves.toEqual({ error: 'Unauthorized gateway access' });

    const authorized = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer gateway-secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ ok: true });
  });

  it('keeps health public even when gateway auth is enabled', async () => {
    const upstream = await startUpstream(200, { ok: true });
    startedServers.push(upstream.app);

    const gateway = await createServer(
      createConfig([{ id: 'health', baseUrl: upstream.baseUrl, apiKey: 'upstream-secret' }], {
        gateway: { authToken: 'gateway-secret' }
      })
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('spreads concurrent least-fail requests across idle upstreams', async () => {
    const upstreamIdsSeen: string[] = [];
    const upstreamA = Fastify();
    const upstreamB = Fastify();

    upstreamA.post('/v1/messages', async () => {
      upstreamIdsSeen.push('a');
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { upstream: 'a' };
    });
    upstreamB.post('/v1/messages', async () => {
      upstreamIdsSeen.push('b');
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { upstream: 'b' };
    });

    await upstreamA.listen({ host: '127.0.0.1', port: 0 });
    await upstreamB.listen({ host: '127.0.0.1', port: 0 });
    startedServers.push(upstreamA, upstreamB);

    const upstreamAAddress = upstreamA.server.address();
    const upstreamBAddress = upstreamB.server.address();

    if (!upstreamAAddress || typeof upstreamAAddress === 'string' || !upstreamBAddress || typeof upstreamBAddress === 'string') {
      throw new Error('failed to resolve upstream address');
    }

    const gateway = await createServer(
      createConfig(
        [
          { id: 'a', baseUrl: `http://127.0.0.1:${upstreamAAddress.port}`, apiKey: 'key-a' },
          { id: 'b', baseUrl: `http://127.0.0.1:${upstreamBAddress.port}`, apiKey: 'key-b' }
        ],
        {
          routing: { strategy: 'least-fail' }
        }
      )
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = gateway.server.address();

    if (!gatewayAddress || typeof gatewayAddress === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
      }),
      fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
      })
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.headers.get('x-upstream-id')).sort()).toEqual(['a', 'b']);
    await Promise.all(responses.map((response) => response.json()));
    expect(upstreamIdsSeen.sort()).toEqual(['a', 'b']);
  });

  it('rejects new requests when the only upstream is at its concurrency limit', async () => {
    const firstRequestReachedUpstream = deferred();
    const releaseFirstRequest = deferred();
    const upstream = Fastify();

    upstream.post('/v1/messages', async () => {
      firstRequestReachedUpstream.resolve();
      await releaseFirstRequest.promise;
      return { ok: true };
    });

    await upstream.listen({ host: '127.0.0.1', port: 0 });
    startedServers.push(upstream);
    const upstreamAddress = upstream.server.address();

    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('failed to resolve upstream address');
    }

    const gateway = await createServer(
      createConfig(
        [{ id: 'limited', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'key', maxConcurrentRequests: 1 }],
        {
          concurrency: { acquireTimeoutMs: 1, maxPendingRequests: 10 },
          retry: {
            maxAttempts: 1,
            perUpstreamRetries: 0,
            backoff: { type: 'fixed', baseDelayMs: 1, maxDelayMs: 1 }
          }
        }
      )
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = gateway.server.address();

    if (!gatewayAddress || typeof gatewayAddress === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const firstResponsePromise = fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    await firstRequestReachedUpstream.promise;

    const secondResponse = await fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });
    expect(secondResponse.status).toBe(503);
    await expect(secondResponse.json()).resolves.toEqual({ error: 'No available upstreams' });

    const statusResponse = await fetch(`http://127.0.0.1:${gatewayAddress.port}/upstreams`);
    const statusJson = (await statusResponse.json()) as { upstreams: Array<{ id: string; available: boolean; inFlight: number }> };
    expect(statusJson.upstreams).toEqual([
      expect.objectContaining({
        id: 'limited',
        available: false,
        inFlight: 1
      })
    ]);

    const metricsResponse = await fetch(`http://127.0.0.1:${gatewayAddress.port}/metrics`);
    const metricsJson = (await metricsResponse.json()) as {
      currentInFlightRequests: number;
      pendingAcquireRequests: number;
      upstreamInFlightById: Record<string, number>;
    };
    expect(metricsJson.currentInFlightRequests).toBe(1);
    expect(metricsJson.pendingAcquireRequests).toBe(0);
    expect(metricsJson.upstreamInFlightById.limited).toBe(1);

    releaseFirstRequest.resolve();

    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({ ok: true });
  });

  it('queues saturated requests and dispatches them when capacity recovers', async () => {
    const firstRequestReachedUpstream = deferred();
    const releaseFirstRequest = deferred();
    const upstream = Fastify();
    let requestCount = 0;

    upstream.post('/v1/messages', async () => {
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestReachedUpstream.resolve();
        await releaseFirstRequest.promise;
      }

      return { requestCount };
    });

    await upstream.listen({ host: '127.0.0.1', port: 0 });
    startedServers.push(upstream);
    const upstreamAddress = upstream.server.address();

    if (!upstreamAddress || typeof upstreamAddress === 'string') {
      throw new Error('failed to resolve upstream address');
    }

    const gateway = await createServer(
      createConfig(
        [{ id: 'queued', baseUrl: `http://127.0.0.1:${upstreamAddress.port}`, apiKey: 'key', maxConcurrentRequests: 1 }],
        {
          concurrency: { acquireTimeoutMs: 1_000, maxPendingRequests: 2 },
          retry: {
            maxAttempts: 1,
            perUpstreamRetries: 0,
            backoff: { type: 'fixed', baseDelayMs: 1, maxDelayMs: 1 }
          }
        }
      )
    );
    startedServers.push(gateway);
    await gateway.listen({ host: '127.0.0.1', port: 0 });
    const gatewayAddress = gateway.server.address();

    if (!gatewayAddress || typeof gatewayAddress === 'string') {
      throw new Error('failed to resolve gateway address');
    }

    const firstResponsePromise = fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    await firstRequestReachedUpstream.promise;

    const secondResponsePromise = fetch(`http://127.0.0.1:${gatewayAddress.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] })
    });

    await waitForExpectation(async () => {
      const metricsResponse = await fetch(`http://127.0.0.1:${gatewayAddress.port}/metrics`);
      const metricsJson = (await metricsResponse.json()) as { currentInFlightRequests: number; pendingAcquireRequests: number };
      expect(metricsJson.currentInFlightRequests).toBe(1);
      expect(metricsJson.pendingAcquireRequests).toBe(1);
    });

    releaseFirstRequest.resolve();

    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({ requestCount: 1 });

    const secondResponse = await secondResponsePromise;
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toEqual({ requestCount: 2 });
  });
});
