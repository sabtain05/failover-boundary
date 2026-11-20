export type BackoffMode =
  | 'fixed'
  | 'linear'
  | 'exponential'
  | 'decorrelated-jitter';

export interface BackoffContext {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  previousDelayMs: number;
  retryAfterMs?: number;
}

export type BackoffStrategy =
  | BackoffMode
  | ((attempt: number, context: BackoffContext) => number);

export type JitterMode = 'none' | 'full' | 'equal';

export type CircuitState = 'closed' | 'open' | 'half-open';

export type StrategyPresetName =
  | 'cellular-drop'
  | 'rate-limit'
  | 'ui-graceful'
  | 'aggressive';

export interface ErrorClassification {
  retryable: boolean;
  authExpired: boolean;
  rateLimited: boolean;
  networkDrop: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}

export interface ExecutionContext {
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  elapsedMs: number;
}

export interface RetryDecisionContext extends ExecutionContext {
  classification: ErrorClassification;
}

export interface FallbackContext<TArgs extends unknown[] = unknown[]> {
  args: TArgs;
  attempts: number;
  elapsedMs: number;
  classification: ErrorClassification;
  circuitOpen: boolean;
}

export type FallbackProvider<T, TArgs extends unknown[] = unknown[]> =
  | T
  | ((error: unknown, context: FallbackContext<TArgs>) => T | Promise<T>);

export interface TokenRefreshOptions {
  refresh: (context: ExecutionContext) => Promise<void> | void;
  shouldRefresh?: (error: unknown, classification: ErrorClassification) => boolean;
  maxRefreshes?: number;
  deduplicate?: boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts?: number;
}

export type BoundaryEvent<T = unknown> =
  | {
      type: 'attempt';
      attempt: number;
      maxAttempts: number;
      timestamp: number;
    }
  | {
      type: 'retry';
      attempt: number;
      nextAttempt: number;
      delayMs: number;
      error: unknown;
      classification: ErrorClassification;
      timestamp: number;
    }
  | {
      type: 'token-refresh';
      attempt: number;
      phase: 'start' | 'success' | 'failure';
      error?: unknown;
      timestamp: number;
    }
  | {
      type: 'fallback';
      data: T;
      error: unknown;
      attempts: number;
      circuitOpen: boolean;
      timestamp: number;
    }
  | {
      type: 'success';
      data: T;
      attempts: number;
      durationMs: number;
      recoveredViaTokenRefresh: boolean;
      timestamp: number;
    }
  | {
      type: 'failure';
      error: unknown;
      attempts: number;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: 'abort';
      attempt: number;
      reason: unknown;
      timestamp: number;
    }
  | {
      type: 'network-wait';
      attempt: number;
      phase: 'waiting' | 'resumed';
      timestamp: number;
    }
  | {
      type: 'circuit-open';
      failures: number;
      resetTimeoutMs: number;
      timestamp: number;
    }
  | {
      type: 'circuit-half-open';
      timestamp: number;
    }
  | {
      type: 'circuit-close';
      timestamp: number;
    };

export type BoundaryEventListener<T = unknown> = (event: BoundaryEvent<T>) => void;

export interface BoundaryResult<T> {
  data: T;
  usedFallback: boolean;
  attempts: number;
  durationMs: number;
  recoveredViaTokenRefresh: boolean;
  error?: unknown;
}

export interface BoundarySnapshot<T = unknown> {
  circuitState: CircuitState;
  consecutiveFailures: number;
  totalCalls: number;
  totalSuccesses: number;
  totalFailures: number;
  totalRetries: number;
  totalFallbacks: number;
  totalTokenRefreshes: number;
  inFlight: number;
  lastFallbackData?: T;
  lastError?: unknown;
}

export interface ResilientBoundaryOptions<
  T,
  TArgs extends unknown[] = unknown[]
> {
  attempts?: number;
  backoff?: BackoffStrategy;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: JitterMode;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  fallback?: FallbackProvider<T, TArgs>;
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
  classifyError?: (error: unknown) => ErrorClassification;
  respectRetryAfter?: boolean;
  tokenRefresh?: TokenRefreshOptions;
  circuitBreaker?: CircuitBreakerOptions;
  waitForOnline?: boolean;
  onlineWaitTimeoutMs?: number;
  strategy?: StrategyPresetName | Partial<ResilientBoundaryOptions<T, TArgs>>;
  signal?: AbortSignal;
  random?: () => number;
  onEvent?: BoundaryEventListener<T>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  onFallback?: (data: T, error: unknown, context: FallbackContext<TArgs>) => void;
}

export type OperationWithContext<T, TArgs extends unknown[] = []> = (
  ...args: TArgs
) => Promise<T> | T;

export interface ResilientBoundary<T, TArgs extends unknown[] = []> {
  (...args: TArgs): Promise<T>;
  executeWithMeta(...args: TArgs): Promise<BoundaryResult<T>>;
  subscribe(listener: BoundaryEventListener<T>): () => void;
  getState(): BoundarySnapshot<T>;
  reset(): void;
  abort(reason?: unknown): void;
}
