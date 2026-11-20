import type {
  FallbackProvider,
  ResilientBoundaryOptions,
  StrategyPresetName,
  TokenRefreshOptions
} from './types.js';

export function cellularDropStrategy<
  T = unknown,
  TArgs extends unknown[] = unknown[]
>(
  overrides: Partial<ResilientBoundaryOptions<T, TArgs>> = {}
): Partial<ResilientBoundaryOptions<T, TArgs>> {
  return {
    attempts: 5,
    backoff: 'decorrelated-jitter',
    baseDelayMs: 300,
    maxDelayMs: 12000,
    jitter: 'full',
    waitForOnline: true,
    onlineWaitTimeoutMs: 15000,
    respectRetryAfter: true,
    ...overrides
  };
}

export function tokenExpirationStrategy<
  T = unknown,
  TArgs extends unknown[] = unknown[]
>(
  refresh: TokenRefreshOptions['refresh'],
  overrides: Partial<ResilientBoundaryOptions<T, TArgs>> = {}
): Partial<ResilientBoundaryOptions<T, TArgs>> {
  const { tokenRefresh, ...rest } = overrides;
  return {
    attempts: 2,
    backoff: 'fixed',
    baseDelayMs: 50,
    jitter: 'none',
    tokenRefresh: {
      refresh,
      maxRefreshes: 1,
      deduplicate: true,
      ...tokenRefresh
    },
    ...rest
  };
}

export function rateLimitStrategy<
  T = unknown,
  TArgs extends unknown[] = unknown[]
>(
  overrides: Partial<ResilientBoundaryOptions<T, TArgs>> = {}
): Partial<ResilientBoundaryOptions<T, TArgs>> {
  return {
    attempts: 4,
    backoff: 'exponential',
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    backoffFactor: 2,
    jitter: 'full',
    respectRetryAfter: true,
    ...overrides
  };
}

export function gracefulUiFallbackStrategy<
  T,
  TArgs extends unknown[] = unknown[]
>(
  fallback: FallbackProvider<T, TArgs>,
  overrides: Partial<ResilientBoundaryOptions<T, TArgs>> = {}
): Partial<ResilientBoundaryOptions<T, TArgs>> {
  return {
    attempts: 2,
    backoff: 'exponential',
    baseDelayMs: 150,
    maxDelayMs: 1500,
    jitter: 'equal',
    fallback,
    ...overrides
  };
}

export function resolveStrategyPreset<
  T,
  TArgs extends unknown[] = unknown[]
>(
  preset: StrategyPresetName
): Partial<ResilientBoundaryOptions<T, TArgs>> {
  switch (preset) {
    case 'cellular-drop':
      return cellularDropStrategy<T, TArgs>();
    case 'rate-limit':
      return rateLimitStrategy<T, TArgs>();
    case 'ui-graceful':
      return {
        attempts: 2,
        backoff: 'exponential',
        baseDelayMs: 150,
        maxDelayMs: 1500,
        jitter: 'equal'
      };
    case 'aggressive':
      return {
        attempts: 6,
        backoff: 'exponential',
        baseDelayMs: 100,
        maxDelayMs: 10000,
        backoffFactor: 2,
        jitter: 'full',
        respectRetryAfter: true
      };
  }
}

export function composeStrategies<
  T,
  TArgs extends unknown[] = unknown[]
>(
  ...strategies: Array<Partial<ResilientBoundaryOptions<T, TArgs>>>
): Partial<ResilientBoundaryOptions<T, TArgs>> {
  const merged: Partial<ResilientBoundaryOptions<T, TArgs>> = {};
  for (const strategy of strategies) {
    Object.assign(merged, strategy);
    if (strategy.tokenRefresh !== undefined) {
      merged.tokenRefresh = {
        ...merged.tokenRefresh,
        ...strategy.tokenRefresh
      };
    }
    if (strategy.circuitBreaker !== undefined) {
      merged.circuitBreaker = {
        ...merged.circuitBreaker,
        ...strategy.circuitBreaker
      };
    }
  }
  return merged;
}
