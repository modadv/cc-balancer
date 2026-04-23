import { describe, expect, it } from 'vitest';

import { expandEnv } from '../../src/config/expandEnv.js';

describe('expandEnv', () => {
  it('expands nested environment variables', () => {
    process.env.TEST_BALANCER_KEY = 'secret-key';

    const expanded = expandEnv({
      upstreams: [
        {
          apiKey: '${TEST_BALANCER_KEY}'
        }
      ]
    });

    expect(expanded.upstreams[0]?.apiKey).toBe('secret-key');
  });

  it('throws when an environment variable is missing', () => {
    delete process.env.TEST_BALANCER_MISSING;

    expect(() => expandEnv({ apiKey: '${TEST_BALANCER_MISSING}' })).toThrow('Missing required environment variable');
  });
});
