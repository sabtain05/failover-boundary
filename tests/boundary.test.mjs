import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundaryAbortError,
  BoundaryExhaustedError,
  BoundaryTimeoutError,
  CircuitOpenError,
  HttpStatusError,
  assertOkResponse,
  cellularDropStrategy,
  composeStrategies,
  computeBackoffDelay,
  createAxiosBoundary,
  createResilientBoundary,
  createTrpcBoundary,
  defaultClassifyError,
  gracefulUiFallbackStrategy,
  parseRetryAfterMs,
  rateLimitStrategy,
  tokenExpirationStrategy
} from '../dist/esm/index.js';

test('retries transient failures with exponential backoff and resolves on recovery', async () => {
  let calls = 0;
  const delays = [];

  const fetchUser = createResilientBoundary(
    async () => {
      calls += 1;
      if (calls < 3) {
        const err = new TypeError('Failed to fetch');
        throw err;
      }
      return { id: 'u_1', guest: false };
    },
    {
      attempts: 3,
      backoff: 'exponential',
      baseDelayMs: 10,
      jitter: 'none',
      onRetry: (_err, _attempt, delayMs) => {
        delays.push(delayMs);
      }
    }
  );

  const result = await fetchUser.executeWithMeta();
  assert.deepEqual(result.data, { id: 'u_1', guest: false });
  assert.equal(result.usedFallback, false);
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(fetchUser.getState().totalRetries, 2);
  assert.equal(fetchUser.getState().totalSuccesses, 1);
});

test('emits graceful UI fallback data when all attempts are exhausted', async () => {
  const events = [];
  let onFallbackCalled = false;

  const fetchUserData = createResilientBoundary(
    async () => {
      throw new TypeError('Failed to fetch');
    },
    {
      attempts: 3,
      backoff: 'exponential',
      baseDelayMs: 5,
      jitter: 'none',
      fallback: { guest: true },
      onFallback: (data, _err, ctx) => {
        onFallbackCalled = true;
        assert.deepEqual(data, { guest: true });
        assert.equal(ctx.attempts, 3);
      }
    }
  );

  const unsubscribe = fetchUserData.subscribe((event) => {
    events.push(event.type);
  });

  const data = await fetchUserData();
  unsubscribe();

  assert.deepEqual(data, { guest: true });
  assert.equal(onFallbackCalled, true);
  assert.equal(events.filter((e) => e === 'attempt').length, 3);
  assert.equal(events.filter((e) => e === 'retry').length, 2);
  assert.equal(events.includes('fallback'), true);
  assert.deepEqual(fetchUserData.getState().lastFallbackData, { guest: true });
});

test('supports async fallback factory with original call arguments', async () => {
  const loadItem = createResilientBoundary(
    async (id) => {
      throw new HttpStatusError(503, 'Service Unavailable', {});
    },
    {
      attempts: 2,
      baseDelayMs: 1,
      jitter: 'none',
      fallback: async (_err, ctx) => ({ id: ctx.args[0], cached: true })
    }
  );

  const item = await loadItem('sku_42');
  assert.deepEqual(item, { id: 'sku_42', cached: true });
});

test('throws BoundaryExhaustedError when no fallback is provided', async () => {
  const failing = createResilientBoundary(
    async () => {
      throw new HttpStatusError(502, 'Bad Gateway', {});
    },
    {
      attempts: 2,
      baseDelayMs: 1,
      jitter: 'none'
    }
  );

  await assert.rejects(() => failing(), (err) => {
    assert.ok(err instanceof BoundaryExhaustedError);
    assert.equal(err.attempts, 2);
    assert.ok(err.lastError instanceof HttpStatusError);
    return true;
  });
});

test('does not retry non-retryable 400 client errors', async () => {
  let calls = 0;
  const boundary = createResilientBoundary(
    async () => {
      calls += 1;
      throw new HttpStatusError(400, 'Bad Request', {});
    },
    {
      attempts: 4,
      baseDelayMs: 1
    }
  );

  await assert.rejects(() => boundary(), HttpStatusError);
  assert.equal(calls, 1);
});

test('deduplicates concurrent token refreshes on 401 responses', async () => {
  let token = 'expired';
  let refreshCount = 0;

  const authedCall = createResilientBoundary(
    async (label) => {
      if (token === 'expired') {
        throw new HttpStatusError(401, 'Unauthorized', {});
      }
      return `${label}:${token}`;
    },
    tokenExpirationStrategy(async () => {
      refreshCount += 1;
      await new Promise((r) => setTimeout(r, 25));
      token = 'fresh';
    })
  );

  const [a, b, c] = await Promise.all([
    authedCall.executeWithMeta('a'),
    authedCall.executeWithMeta('b'),
    authedCall.executeWithMeta('c')
  ]);

  assert.equal(refreshCount, 1);
  assert.equal(a.data, 'a:fresh');
  assert.equal(b.data, 'b:fresh');
  assert.equal(c.data, 'c:fresh');
  assert.equal(a.recoveredViaTokenRefresh, true);
});

test('respects Retry-After header from rate-limited Axios and Fetch errors', async () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs(1.5), 1500);

  const axios429 = {
    isAxiosError: true,
    response: {
      status: 429,
      headers: { 'Retry-After': '0.03' }
    }
  };

  const classification = defaultClassifyError(axios429);
  assert.equal(classification.rateLimited, true);
  assert.equal(classification.retryable, true);
  assert.equal(classification.retryAfterMs, 30);

  let observedDelay = 0;
  let calls = 0;
  const axiosBoundary = createAxiosBoundary(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw axios429;
      }
      return { data: { ok: true } };
    },
    {
      attempts: 2,
      baseDelayMs: 5,
      jitter: 'none',
      respectRetryAfter: true,
      onRetry: (_e, _a, delayMs) => {
        observedDelay = delayMs;
      }
    }
  );

  const data = await axiosBoundary();
  assert.deepEqual(data, { ok: true });
  assert.ok(observedDelay >= 30);
});

test('classifies tRPC errors accurately and supports createTrpcBoundary', async () => {
  const trpcError = {
    data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 }
  };
  const cls = defaultClassifyError(trpcError);
  assert.equal(cls.rateLimited, true);
  assert.equal(cls.retryable, true);
  assert.equal(cls.statusCode, 429);

  let calls = 0;
  const trpcCall = createTrpcBoundary(
    async (id) => {
      calls += 1;
      if (calls === 1) {
        throw { data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 } };
      }
      return { id, status: 'ok' };
    },
    { attempts: 2, baseDelayMs: 1, jitter: 'none' }
  );

  const res = await trpcCall('job_1');
  assert.deepEqual(res, { id: 'job_1', status: 'ok' });
});

test('opens circuit breaker after threshold and recovers after reset timeout', async () => {
  let shouldFail = true;
  const events = [];

  const guarded = createResilientBoundary(
    async () => {
      if (shouldFail) {
        throw new HttpStatusError(500, 'Internal Server Error', {});
      }
      return { healthy: true };
    },
    {
      attempts: 1,
      fallback: { healthy: false },
      circuitBreaker: {
        failureThreshold: 2,
        resetTimeoutMs: 40
      },
      onEvent: (e) => events.push(e.type)
    }
  );

  await guarded();
  await guarded();
  assert.equal(guarded.getState().circuitState, 'open');

  const shortCircuited = await guarded.executeWithMeta();
  assert.deepEqual(shortCircuited.data, { healthy: false });
  assert.equal(shortCircuited.attempts, 0);
  assert.ok(shortCircuited.error instanceof CircuitOpenError);

  await new Promise((r) => setTimeout(r, 50));
  shouldFail = false;

  const recovered = await guarded.executeWithMeta();
  assert.deepEqual(recovered.data, { healthy: true });
  assert.equal(guarded.getState().circuitState, 'closed');
  assert.equal(events.includes('circuit-open'), true);
  assert.equal(events.includes('circuit-half-open'), true);
  assert.equal(events.includes('circuit-close'), true);
});

test('enforces per-attempt timeout and total timeout', async () => {
  const slow = createResilientBoundary(
    () => new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
    {
      attempts: 2,
      timeoutMs: 15,
      baseDelayMs: 1,
      jitter: 'none'
    }
  );

  await assert.rejects(() => slow(), (err) => {
    assert.ok(err instanceof BoundaryExhaustedError);
    assert.ok(err.lastError instanceof BoundaryTimeoutError);
    return true;
  });
});

test('cancels in-flight retry sleep when aborted', async () => {
  const controller = new AbortController();
  const boundary = createResilientBoundary(
    async () => {
      throw new TypeError('Failed to fetch');
    },
    {
      attempts: 3,
      baseDelayMs: 500,
      jitter: 'none',
      signal: controller.signal
    }
  );

  setTimeout(() => controller.abort('user-navigated'), 20);

  await assert.rejects(() => boundary(), BoundaryAbortError);
});

test('computes fixed, linear, exponential, decorrelated-jitter, and custom backoffs', () => {
  const fixed = computeBackoffDelay({
    attempt: 3,
    strategy: 'fixed',
    baseDelayMs: 100,
    maxDelayMs: 1000,
    backoffFactor: 2,
    jitter: 'none',
    previousDelayMs: 0,
    respectRetryAfter: true,
    random: () => 0.5
  });
  assert.equal(fixed, 100);

  const linear = computeBackoffDelay({
    attempt: 3,
    strategy: 'linear',
    baseDelayMs: 100,
    maxDelayMs: 1000,
    backoffFactor: 2,
    jitter: 'none',
    previousDelayMs: 0,
    respectRetryAfter: true,
    random: () => 0.5
  });
  assert.equal(linear, 300);

  const expFullJitter = computeBackoffDelay({
    attempt: 3,
    strategy: 'exponential',
    baseDelayMs: 100,
    maxDelayMs: 1000,
    backoffFactor: 2,
    jitter: 'full',
    previousDelayMs: 0,
    respectRetryAfter: true,
    random: () => 0.5
  });
  assert.equal(expFullJitter, 200);

  const decorrelated = computeBackoffDelay({
    attempt: 2,
    strategy: 'decorrelated-jitter',
    baseDelayMs: 100,
    maxDelayMs: 1000,
    backoffFactor: 2,
    jitter: 'full',
    previousDelayMs: 200,
    respectRetryAfter: true,
    random: () => 0.5
  });
  assert.equal(decorrelated, 350);
});

test('composes strategies cleanly and isolates throwing subscribers', async () => {
  const composed = composeStrategies(
    cellularDropStrategy(),
    rateLimitStrategy({ maxDelayMs: 5000 }),
    gracefulUiFallbackStrategy({ offline: true }, { baseDelayMs: 1, jitter: 'none' })
  );

  assert.equal(composed.waitForOnline, true);
  assert.equal(composed.maxDelayMs, 1500);
  assert.equal(composed.attempts, 2);

  const boundary = createResilientBoundary(
    async () => {
      throw new TypeError('network error');
    },
    composed
  );

  boundary.subscribe(() => {
    throw new Error('subscriber bug');
  });

  const result = await boundary();
  assert.deepEqual(result, { offline: true });
});

test('assertOkResponse throws HttpStatusError on non-2xx responses', () => {
  const fakeBadResponse = {
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
    headers: new Headers({ 'Retry-After': '5' })
  };

  assert.throws(() => assertOkResponse(fakeBadResponse), (err) => {
    assert.ok(err instanceof HttpStatusError);
    assert.equal(err.status, 503);
    return true;
  });
});
