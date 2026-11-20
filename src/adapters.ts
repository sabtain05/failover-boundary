import { createResilientBoundary } from './boundary.js';
import { HttpStatusError } from './errors.js';
import type { ResilientBoundary, ResilientBoundaryOptions } from './types.js';

export function assertOkResponse(response: Response): Response {
  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      response.statusText,
      response.headers,
      response
    );
  }
  return response;
}

export function createFetchBoundary<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ResilientBoundaryOptions<T, [RequestInit?]> = {}
): ResilientBoundary<T, [RequestInit?]> {
  return createResilientBoundary<T, [RequestInit?]>(async (overrideInit?: RequestInit) => {
    const response = await fetch(input, { ...init, ...overrideInit });
    assertOkResponse(response);
    return (await response.json()) as T;
  }, options);
}

export function createAxiosBoundary<T, TArgs extends unknown[] = []>(
  requestFn: (...args: TArgs) => Promise<{ data: T }>,
  options: ResilientBoundaryOptions<T, TArgs> = {}
): ResilientBoundary<T, TArgs> {
  return createResilientBoundary<T, TArgs>(async (...args: TArgs) => {
    const response = await requestFn(...args);
    return response.data;
  }, options);
}

export function createTrpcBoundary<T, TArgs extends unknown[] = []>(
  procedureFn: (...args: TArgs) => Promise<T>,
  options: ResilientBoundaryOptions<T, TArgs> = {}
): ResilientBoundary<T, TArgs> {
  return createResilientBoundary<T, TArgs>(procedureFn, options);
}
