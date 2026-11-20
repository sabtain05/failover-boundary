import { computeBackoffDelay } from './backoff.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { BoundaryEmitter } from './emitter.js';
import {
  BoundaryAbortError,
  BoundaryExhaustedError,
  BoundaryTimeoutError,
  CircuitOpenError,
  defaultClassifyError
} from './errors.js';
import { resolveStrategyPreset } from './strategies.js';
import type {
  BoundaryEventListener,
  BoundaryResult,
  BoundarySnapshot,
  ErrorClassification,
  ExecutionContext,
  FallbackContext,
  FallbackProvider,
  OperationWithContext,
  ResilientBoundary,
  ResilientBoundaryOptions,
  TokenRefreshOptions
} from './types.js';

interface NetworkAwareGlobal {
  navigator?: { onLine?: boolean };
  addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

class TokenRefreshCoordinator {
  private inFlightRefresh: Promise<void> | null = null;

  public async run(
    options: TokenRefreshOptions,
    context: ExecutionContext
  ): Promise<void> {
    if (options.deduplicate !== false && this.inFlightRefresh !== null) {
      await this.inFlightRefresh;
      return;
    }

    const promise = Promise.resolve().then(() => options.refresh(context));
    if (options.deduplicate !== false) {
      this.inFlightRefresh = promise;
    }

    try {
      await promise;
    } finally {
      if (this.inFlightRefresh === promise) {
        this.inFlightRefresh = null;
      }
    }
  }
}

function linkSignals(
  signals: Array<AbortSignal | undefined>
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      return { controller, cleanup: () => {} };
    }
    const onAbort = (): void => {
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }

  return {
    controller,
    cleanup: () => {
      for (const fn of cleanups) {
        fn();
      }
    }
  };
}

function cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal.aborted
      ? Promise.reject(new BoundaryAbortError(signal.reason))
      : Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new BoundaryAbortError(signal.reason));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BoundaryAbortError(signal.reason));
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isBrowserOffline(): boolean {
  const host = globalThis as unknown as NetworkAwareGlobal;
  return host.navigator !== undefined && host.navigator.onLine === false;
}

function waitForNetworkOnline(
  signal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  if (!isBrowserOffline()) {
    return Promise.resolve();
  }

  const host = globalThis as unknown as NetworkAwareGlobal;
  if (typeof host.addEventListener !== 'function') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new BoundaryAbortError(signal.reason));
      return;
    }

    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (typeof host.removeEventListener === 'function') {
        host.removeEventListener('online', onOnline);
      }
    };

    const onOnline = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new BoundaryAbortError(signal.reason));
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new BoundaryTimeoutError(timeoutMs, 'online-wait'));
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });
    host.addEventListener?.('online', onOnline, { once: true });
  });
}

function executeWithTimeout<T>(
  operation: () => Promise<T> | T,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  scope: 'attempt' | 'total'
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BoundaryAbortError(signal.reason));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new BoundaryAbortError(signal.reason));
    };

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new BoundaryTimeoutError(timeoutMs, scope));
      }, timeoutMs);
    }

    signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve()
      .then(() => operation())
      .then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        },
        (err) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(err);
        }
      );
  });
}

function isFallbackFunction<T, TArgs extends unknown[]>(
  provider: FallbackProvider<T, TArgs>
): provider is (error: unknown, context: FallbackContext<TArgs>) => T | Promise<T> {
  return typeof provider === 'function';
}

function mergeOptions<T, TArgs extends unknown[]>(
  options: ResilientBoundaryOptions<T, TArgs>
): ResilientBoundaryOptions<T, TArgs> {
  if (options.strategy === undefined) {
    return options;
  }
  const base =
    typeof options.strategy === 'string'
      ? resolveStrategyPreset<T, TArgs>(options.strategy)
      : options.strategy;
  return {
    ...base,
    ...options
  };
}

export function createResilientBoundary<
  T,
  TArgs extends unknown[] = []
>(
  operation: OperationWithContext<T, TArgs>,
  rawOptions: ResilientBoundaryOptions<T, TArgs> = {}
): ResilientBoundary<T, TArgs> {
  const options = mergeOptions(rawOptions);
  const maxAttempts = Math.max(1, options.attempts ?? 3);
  const backoffStrategy = options.backoff ?? 'exponential';
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const backoffFactor = options.backoffFactor ?? 2;
  const jitter = options.jitter ?? 'full';
  const respectRetryAfter = options.respectRetryAfter ?? true;
  const classifyError = options.classifyError ?? defaultClassifyError;
  const random = options.random ?? Math.random;
  const hasFallback = Object.prototype.hasOwnProperty.call(options, 'fallback');
  const waitForOnline = options.waitForOnline ?? false;
  const onlineWaitTimeoutMs = options.onlineWaitTimeoutMs ?? 15000;

  const emitter = new BoundaryEmitter<T>();
  if (options.onEvent) {
    emitter.subscribe(options.onEvent);
  }

  const circuitBreaker = options.circuitBreaker
    ? new CircuitBreaker(options.circuitBreaker)
    : null;

  const tokenCoordinator = new TokenRefreshCoordinator();
  const activeControllers = new Set<AbortController>();

  let totalCalls = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  let totalRetries = 0;
  let totalFallbacks = 0;
  let totalTokenRefreshes = 0;
  let inFlight = 0;
  let lastFallbackData: T | undefined;
  let hasLastFallback = false;
  let lastError: unknown;
  let hasLastError = false;

  async function resolveFallback(
    error: unknown,
    args: TArgs,
    attempts: number,
    elapsedMs: number,
    classification: ErrorClassification,
    circuitOpen: boolean
  ): Promise<T> {
    const context: FallbackContext<TArgs> = {
      args,
      attempts,
      elapsedMs,
      classification,
      circuitOpen
    };
    const provider = options.fallback as FallbackProvider<T, TArgs>;
    const data = isFallbackFunction(provider)
      ? await provider(error, context)
      : provider;

    totalFallbacks += 1;
    lastFallbackData = data;
    hasLastFallback = true;

    options.onFallback?.(data, error, context);
    emitter.emit({
      type: 'fallback',
      data,
      error,
      attempts,
      circuitOpen,
      timestamp: Date.now()
    });

    return data;
  }

  async function executeWithMeta(...args: TArgs): Promise<BoundaryResult<T>> {
    const startedAt = Date.now();
    totalCalls += 1;
    inFlight += 1;

    const { controller: callController, cleanup: cleanupSignals } = linkSignals([
      options.signal
    ]);
    activeControllers.add(callController);

    let totalTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimedOut = false;

    if (options.totalTimeoutMs !== undefined && options.totalTimeoutMs > 0) {
      totalTimeoutTimer = setTimeout(() => {
        totalTimedOut = true;
        callController.abort(new BoundaryTimeoutError(options.totalTimeoutMs as number, 'total'));
      }, options.totalTimeoutMs);
    }

    let attempt = 0;
    let previousDelayMs = 0;
    let refreshesPerformed = 0;
    let recoveredViaTokenRefresh = false;

    try {
      if (circuitBreaker) {
        const check = circuitBreaker.canExecute();
        if (check.transition?.to === 'half-open') {
          emitter.emit({
            type: 'circuit-half-open',
            timestamp: Date.now()
          });
        }
        if (!check.allowed) {
          const openErr = new CircuitOpenError(circuitBreaker.getNextAttemptAt());
          lastError = openErr;
          hasLastError = true;
          totalFailures += 1;

          if (hasFallback) {
            const fallbackData = await resolveFallback(
              openErr,
              args,
              0,
              Date.now() - startedAt,
              classifyError(openErr),
              true
            );
            return {
              data: fallbackData,
              usedFallback: true,
              attempts: 0,
              durationMs: Date.now() - startedAt,
              recoveredViaTokenRefresh: false,
              error: openErr
            };
          }

          emitter.emit({
            type: 'failure',
            error: openErr,
            attempts: 0,
            durationMs: Date.now() - startedAt,
            timestamp: Date.now()
          });
          throw openErr;
        }
      }

      while (attempt < maxAttempts) {
        if (callController.signal.aborted) {
          const abortReason = totalTimedOut
            ? new BoundaryTimeoutError(options.totalTimeoutMs as number, 'total')
            : new BoundaryAbortError(callController.signal.reason);
          emitter.emit({
            type: 'abort',
            attempt,
            reason: abortReason,
            timestamp: Date.now()
          });
          throw abortReason;
        }

        attempt += 1;
        emitter.emit({
          type: 'attempt',
          attempt,
          maxAttempts,
          timestamp: Date.now()
        });

        try {
          const data = await executeWithTimeout(
            () => operation(...args),
            options.timeoutMs,
            callController.signal,
            'attempt'
          );

          if (circuitBreaker) {
            const transition = circuitBreaker.recordSuccess();
            if (transition?.to === 'closed') {
              emitter.emit({
                type: 'circuit-close',
                timestamp: Date.now()
              });
            }
          }

          totalSuccesses += 1;
          const durationMs = Date.now() - startedAt;

          emitter.emit({
            type: 'success',
            data,
            attempts: attempt,
            durationMs,
            recoveredViaTokenRefresh,
            timestamp: Date.now()
          });

          return {
            data,
            usedFallback: false,
            attempts: attempt,
            durationMs,
            recoveredViaTokenRefresh
          };
        } catch (error) {
          const effectiveError =
            totalTimedOut && error instanceof BoundaryAbortError
              ? new BoundaryTimeoutError(options.totalTimeoutMs as number, 'total')
              : error;

          lastError = effectiveError;
          hasLastError = true;

          if (
            effectiveError instanceof BoundaryAbortError ||
            (effectiveError instanceof BoundaryTimeoutError &&
              effectiveError.scope === 'total')
          ) {
            emitter.emit({
              type: 'abort',
              attempt,
              reason: effectiveError,
              timestamp: Date.now()
            });
            totalFailures += 1;
            if (hasFallback && effectiveError instanceof BoundaryTimeoutError) {
              const fallbackData = await resolveFallback(
                effectiveError,
                args,
                attempt,
                Date.now() - startedAt,
                classifyError(effectiveError),
                false
              );
              return {
                data: fallbackData,
                usedFallback: true,
                attempts: attempt,
                durationMs: Date.now() - startedAt,
                recoveredViaTokenRefresh,
                error: effectiveError
              };
            }
            throw effectiveError;
          }

          const classification = classifyError(effectiveError);
          const tokenOpts = options.tokenRefresh;
          const maxRefreshes = tokenOpts?.maxRefreshes ?? 1;
          const shouldRefreshToken =
            tokenOpts !== undefined &&
            refreshesPerformed < maxRefreshes &&
            (tokenOpts.shouldRefresh
              ? tokenOpts.shouldRefresh(effectiveError, classification)
              : classification.authExpired);

          if (shouldRefreshToken && tokenOpts) {
            refreshesPerformed += 1;
            totalTokenRefreshes += 1;
            emitter.emit({
              type: 'token-refresh',
              attempt,
              phase: 'start',
              timestamp: Date.now()
            });

            try {
              await tokenCoordinator.run(tokenOpts, {
                attempt,
                maxAttempts,
                signal: callController.signal,
                elapsedMs: Date.now() - startedAt
              });
              recoveredViaTokenRefresh = true;
              emitter.emit({
                type: 'token-refresh',
                attempt,
                phase: 'success',
                timestamp: Date.now()
              });
              attempt -= 1;
              continue;
            } catch (refreshError) {
              emitter.emit({
                type: 'token-refresh',
                attempt,
                phase: 'failure',
                error: refreshError,
                timestamp: Date.now()
              });
              lastError = refreshError;
              totalFailures += 1;

              if (circuitBreaker) {
                const transition = circuitBreaker.recordFailure();
                if (transition?.to === 'open') {
                  emitter.emit({
                    type: 'circuit-open',
                    failures: circuitBreaker.getConsecutiveFailures(),
                    resetTimeoutMs: options.circuitBreaker?.resetTimeoutMs ?? 0,
                    timestamp: Date.now()
                  });
                }
              }

              if (hasFallback) {
                const fallbackData = await resolveFallback(
                  refreshError,
                  args,
                  attempt,
                  Date.now() - startedAt,
                  classifyError(refreshError),
                  false
                );
                return {
                  data: fallbackData,
                  usedFallback: true,
                  attempts: attempt,
                  durationMs: Date.now() - startedAt,
                  recoveredViaTokenRefresh: false,
                  error: refreshError
                };
              }

              emitter.emit({
                type: 'failure',
                error: refreshError,
                attempts: attempt,
                durationMs: Date.now() - startedAt,
                timestamp: Date.now()
              });
              throw refreshError;
            }
          }

          const hasAttemptsLeft = attempt < maxAttempts;
          const retryDecision = options.shouldRetry
            ? options.shouldRetry(effectiveError, {
                attempt,
                maxAttempts,
                signal: callController.signal,
                elapsedMs: Date.now() - startedAt,
                classification
              })
            : classification.retryable;

          if (hasAttemptsLeft && retryDecision) {
            if (waitForOnline && classification.networkDrop && isBrowserOffline()) {
              emitter.emit({
                type: 'network-wait',
                attempt,
                phase: 'waiting',
                timestamp: Date.now()
              });
              await waitForNetworkOnline(callController.signal, onlineWaitTimeoutMs);
              emitter.emit({
                type: 'network-wait',
                attempt,
                phase: 'resumed',
                timestamp: Date.now()
              });
            }

            const backoffInput: Parameters<typeof computeBackoffDelay>[0] = {
              attempt,
              strategy: backoffStrategy,
              baseDelayMs,
              maxDelayMs,
              backoffFactor,
              jitter,
              previousDelayMs,
              respectRetryAfter,
              random
            };
            if (classification.retryAfterMs !== undefined) {
              backoffInput.retryAfterMs = classification.retryAfterMs;
            }

            const delayMs = computeBackoffDelay(backoffInput);
            previousDelayMs = delayMs;
            totalRetries += 1;

            options.onRetry?.(effectiveError, attempt, delayMs);
            emitter.emit({
              type: 'retry',
              attempt,
              nextAttempt: attempt + 1,
              delayMs,
              error: effectiveError,
              classification,
              timestamp: Date.now()
            });

            await cancellableDelay(delayMs, callController.signal);
            continue;
          }

          totalFailures += 1;

          if (circuitBreaker) {
            const transition = circuitBreaker.recordFailure();
            if (transition?.to === 'open') {
              emitter.emit({
                type: 'circuit-open',
                failures: circuitBreaker.getConsecutiveFailures(),
                resetTimeoutMs: options.circuitBreaker?.resetTimeoutMs ?? 0,
                timestamp: Date.now()
              });
            }
          }

          if (hasFallback) {
            const fallbackData = await resolveFallback(
              effectiveError,
              args,
              attempt,
              Date.now() - startedAt,
              classification,
              false
            );
            return {
              data: fallbackData,
              usedFallback: true,
              attempts: attempt,
              durationMs: Date.now() - startedAt,
              recoveredViaTokenRefresh,
              error: effectiveError
            };
          }

          const durationMs = Date.now() - startedAt;
          emitter.emit({
            type: 'failure',
            error: effectiveError,
            attempts: attempt,
            durationMs,
            timestamp: Date.now()
          });

          throw attempt > 1
            ? new BoundaryExhaustedError(attempt, effectiveError)
            : effectiveError;
        }
      }

      throw new BoundaryExhaustedError(attempt, lastError);
    } finally {
      if (totalTimeoutTimer !== undefined) {
        clearTimeout(totalTimeoutTimer);
      }
      cleanupSignals();
      activeControllers.delete(callController);
      inFlight -= 1;
    }
  }

  const boundary = (async (...args: TArgs): Promise<T> => {
    const result = await executeWithMeta(...args);
    return result.data;
  }) as ResilientBoundary<T, TArgs>;

  boundary.executeWithMeta = executeWithMeta;

  boundary.subscribe = (listener: BoundaryEventListener<T>): (() => void) => {
    return emitter.subscribe(listener);
  };

  boundary.getState = (): BoundarySnapshot<T> => {
    const snapshot: BoundarySnapshot<T> = {
      circuitState: circuitBreaker ? circuitBreaker.getState() : 'closed',
      consecutiveFailures: circuitBreaker
        ? circuitBreaker.getConsecutiveFailures()
        : 0,
      totalCalls,
      totalSuccesses,
      totalFailures,
      totalRetries,
      totalFallbacks,
      totalTokenRefreshes,
      inFlight
    };
    if (hasLastFallback) {
      snapshot.lastFallbackData = lastFallbackData as T;
    }
    if (hasLastError) {
      snapshot.lastError = lastError;
    }
    return snapshot;
  };

  boundary.reset = (): void => {
    circuitBreaker?.reset();
    totalCalls = 0;
    totalSuccesses = 0;
    totalFailures = 0;
    totalRetries = 0;
    totalFallbacks = 0;
    totalTokenRefreshes = 0;
    lastFallbackData = undefined;
    hasLastFallback = false;
    lastError = undefined;
    hasLastError = false;
  };

  boundary.abort = (reason?: unknown): void => {
    for (const controller of activeControllers) {
      controller.abort(reason);
    }
    activeControllers.clear();
  };

  return boundary;
}
