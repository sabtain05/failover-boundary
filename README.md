# failover-boundary

Decoupled, framework-agnostic resilient network failover engine for TypeScript and JavaScript.

Wrap any Promise-returning function, native `fetch`, Axios request, or tRPC procedure in a self-healing execution boundary with exponential backoff, jitter, `Retry-After` compliance, single-flight token refresh deduplication, circuit breaking, cellular offline recovery, and graceful UI fallback emission.

## Highlights

- Zero runtime dependencies with strict TypeScript generics and dual ESM/CJS exports.
- Drop-in compatibility with native `fetch`, Axios, tRPC, GraphQL clients, and custom SDKs.
- Built-in backoff algorithms (`fixed`, `linear`, `exponential`, `decorrelated-jitter`, or custom) with `none`, `full`, and `equal` jitter modes.
- Pre-configured strategies for cellular drops, token expiration handling, API rate limits, and graceful UI fallback emission.
- Single-flight token refresh mutex prevents concurrent `401` responses from triggering duplicate auth refreshes.
- Headless pub-sub event emitter (`subscribe`) decouples network telemetry and fallback notifications from UI frameworks.
- Finite-state circuit breaker (`closed`, `open`, `half-open`) protects downstream services and short-circuits to fallback data.
- Full `AbortSignal`, per-attempt timeout, and total execution deadline support.

## Installation

```bash
npm install failover-boundary
```

## Quick Start

```ts
import { createResilientBoundary } from 'failover-boundary';

const fetchUserData = createResilientBoundary(
  () => fetch('/api/user').then(res => res.json()),
  { attempts: 3, backoff: 'exponential', fallback: { guest: true } }
);

const data = await fetchUserData();
```

## Core API

### `createResilientBoundary(operation, options?)`

Wraps `operation` and returns a callable `ResilientBoundary` function with attached control and observability methods:

| Method | Signature | Description |
| :--- | :--- | :--- |
| Call | `(...args) => Promise<T>` | Executes the boundary and resolves to the primary or fallback value. |
| `executeWithMeta` | `(...args) => Promise<BoundaryResult<T>>` | Returns `{ data, usedFallback, attempts, durationMs, recoveredViaTokenRefresh, error? }`. |
| `subscribe` | `(listener) => () => void` | Registers a headless observer for `attempt`, `retry`, `token-refresh`, `fallback`, `success`, `failure`, `abort`, `network-wait`, and circuit events. |
| `getState` | `() => BoundarySnapshot<T>` | Returns circuit state, counters, `inFlight`, `lastFallbackData`, and `lastError`. |
| `reset` | `() => void` | Resets circuit breaker state and internal counters. |
| `abort` | `(reason?) => void` | Aborts all currently in-flight executions for this boundary. |

### Options Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `attempts` | `number` | `3` | Maximum total execution attempts. |
| `backoff` | `'fixed' \| 'linear' \| 'exponential' \| 'decorrelated-jitter' \| fn` | `'exponential'` | Delay curve between retries. |
| `baseDelayMs` | `number` | `200` | Base delay in milliseconds. |
| `maxDelayMs` | `number` | `30000` | Upper bound for any retry delay. |
| `backoffFactor` | `number` | `2` | Exponential multiplier per attempt. |
| `jitter` | `'none' \| 'full' \| 'equal'` | `'full'` | Jitter randomization strategy. |
| `timeoutMs` | `number` | `undefined` | Per-attempt timeout in milliseconds. |
| `totalTimeoutMs` | `number` | `undefined` | End-to-end deadline across all attempts. |
| `fallback` | `T \| ((error, ctx) => T \| Promise<T>)` | `undefined` | Static value or factory invoked when retries are exhausted or the circuit is open. |
| `shouldRetry` | `(error, ctx) => boolean` | Classifier-driven | Overrides retry eligibility per attempt. |
| `classifyError` | `(error) => ErrorClassification` | `defaultClassifyError` | Maps thrown errors to retryable, auth-expired, rate-limited, and network-drop flags. |
| `respectRetryAfter` | `boolean` | `true` | Honors `Retry-After` response headers (delta-seconds or HTTP-date). |
| `tokenRefresh` | `TokenRefreshOptions` | `undefined` | Configures `401` / `UNAUTHORIZED` refresh with single-flight deduplication. |
| `circuitBreaker` | `CircuitBreakerOptions` | `undefined` | Enables failure threshold and automatic recovery window. |
| `waitForOnline` | `boolean` | `false` | Pauses retries while `navigator.onLine === false` until the `online` event fires. |
| `onlineWaitTimeoutMs` | `number` | `15000` | Maximum time to wait for connectivity restoration. |
| `strategy` | `StrategyPresetName \| Partial<Options>` | `undefined` | Applies a base preset (`cellular-drop`, `rate-limit`, `ui-graceful`, `aggressive`). |
| `signal` | `AbortSignal` | `undefined` | External cancellation signal. |
| `onEvent` | `BoundaryEventListener<T>` | `undefined` | Initial event listener. |
| `onRetry` | `(error, attempt, delayMs) => void` | `undefined` | Invoked before sleeping for each retry. |
| `onFallback` | `(data, error, ctx) => void` | `undefined` | Invoked whenever fallback data is emitted. |

## Pre-Configured Strategies

### Cellular Drop Recovery

```ts
import {
  createResilientBoundary,
  cellularDropStrategy,
  assertOkResponse
} from 'failover-boundary';

const syncFeed = createResilientBoundary(
  async () => {
    const res = await fetch('/api/feed');
    return assertOkResponse(res).json();
  },
  cellularDropStrategy({
    fallback: []
  })
);
```

### Deduplicated Token Expiration Handling

```ts
import {
  createResilientBoundary,
  tokenExpirationStrategy,
  assertOkResponse
} from 'failover-boundary';

let accessToken = 'initial-token';

const fetchProfile = createResilientBoundary(
  async () => {
    const res = await fetch('/api/profile', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return assertOkResponse(res).json();
  },
  tokenExpirationStrategy(async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST' });
    const body = await assertOkResponse(res).json();
    accessToken = body.accessToken;
  })
);
```

### Composing Multiple Strategies with Graceful UI Fallback Emitting

```ts
import {
  createResilientBoundary,
  composeStrategies,
  cellularDropStrategy,
  rateLimitStrategy,
  gracefulUiFallbackStrategy
} from 'failover-boundary';

const loadDashboard = createResilientBoundary(
  (workspaceId: string) => trpcClient.dashboard.get.query({ workspaceId }),
  composeStrategies(
    cellularDropStrategy(),
    rateLimitStrategy(),
    gracefulUiFallbackStrategy({ widgets: [], degraded: true })
  )
);

const unsubscribe = loadDashboard.subscribe((event) => {
  if (event.type === 'fallback') {
    toast.warning('Showing cached offline view');
  }
});

const dashboard = await loadDashboard('ws_123');
unsubscribe();
```

## Client Adapters

### Native Fetch

```ts
import { createFetchBoundary } from 'failover-boundary';

const getCatalog = createFetchBoundary<{ items: string[] }>(
  '/api/catalog',
  { headers: { Accept: 'application/json' } },
  { attempts: 3, backoff: 'exponential', fallback: { items: [] } }
);
```

### Axios

```ts
import axios from 'axios';
import { createAxiosBoundary } from 'failover-boundary';

const getOrders = createAxiosBoundary(
  (customerId: string) => axios.get(`/api/customers/${customerId}/orders`),
  { strategy: 'rate-limit', fallback: [] }
);
```

### tRPC

```ts
import { createTrpcBoundary } from 'failover-boundary';

const getNotifications = createTrpcBoundary(
  () => trpc.notifications.list.query(),
  { attempts: 3, backoff: 'decorrelated-jitter', fallback: [] }
);
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT
