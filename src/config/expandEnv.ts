const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function expandString(value: string): string {
  return value.replace(ENV_PATTERN, (_match, envName: string) => {
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(`Missing required environment variable: ${envName}`);
    }
    return envValue;
  });
}

export function expandEnv<T>(value: T): T {
  if (typeof value === 'string') {
    return expandString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnv(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [key, expandEnv(nestedValue)])
    ) as T;
  }

  return value;
}
