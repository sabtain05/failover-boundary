# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

## [1.0.0] - 2026-11-20

### Added

- Core `createResilientBoundary` engine with strict TypeScript generics, argument forwarding, and `executeWithMeta` diagnostics.
- Backoff engine supporting `fixed`, `linear`, `exponential`, `decorrelated-jitter`, and custom functions with `none`, `full`, and `equal` jitter modes.
- Universal error classifier (`defaultClassifyError`) supporting native Fetch, Axios, tRPC, HTTP status codes, network error codes, and `Retry-After` header parsing.
- Single-flight deduplicated token refresh coordinator for `401` and `UNAUTHORIZED` recovery.
- Finite-state `CircuitBreaker` (`closed`, `open`, `half-open`) with automatic recovery window and fallback short-circuiting.
- Headless pub-sub `BoundaryEmitter` (`subscribe`, `onEvent`, `onRetry`, `onFallback`) for decoupled UI fallback emission and observability.
- Pre-configured strategy presets and factories: `cellularDropStrategy`, `tokenExpirationStrategy`, `rateLimitStrategy`, `gracefulUiFallbackStrategy`, and `composeStrategies`.
- Thin client adapters: `assertOkResponse`, `createFetchBoundary`, `createAxiosBoundary`, and `createTrpcBoundary`.
- Dual ESM and CommonJS package build configuration with bundled `.d.ts` declarations and automated Node test suite.
