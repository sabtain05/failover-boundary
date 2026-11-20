import type { ErrorClassification } from './types.js';

export class BoundaryError extends Error {
  public readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'BoundaryError';
    this.code = code;
  }
}

export class BoundaryExhaustedError extends BoundaryError {
  public readonly attempts: number;
  public readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    const suffix =
      lastError instanceof Error ? `: ${lastError.message}` : '';
    super(
      `Operation failed after ${attempts} attempt${attempts === 1 ? '' : 's'}${suffix}`,
      'BOUNDARY_EXHAUSTED',
      lastError
    );
    this.name = 'BoundaryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export class BoundaryTimeoutError extends BoundaryError {
  public readonly timeoutMs: number;
  public readonly scope: 'attempt' | 'total' | 'online-wait';

  constructor(timeoutMs: number, scope: 'attempt' | 'total' | 'online-wait') {
    super(
      `Boundary ${scope} timed out after ${timeoutMs}ms`,
      'BOUNDARY_TIMEOUT'
    );
    this.name = 'BoundaryTimeoutError';
    this.timeoutMs = timeoutMs;
    this.scope = scope;
  }
}

export class BoundaryAbortError extends BoundaryError {
  constructor(reason?: unknown) {
    super('Boundary execution was aborted', 'BOUNDARY_ABORTED', reason);
    this.name = 'BoundaryAbortError';
  }
}

export class CircuitOpenError extends BoundaryError {
  public readonly nextAttemptAt: number;

  constructor(nextAttemptAt: number) {
    super(
      `Circuit breaker is open until ${new Date(nextAttemptAt).toISOString()}`,
      'CIRCUIT_OPEN'
    );
    this.name = 'CircuitOpenError';
    this.nextAttemptAt = nextAttemptAt;
  }
}

export class HttpStatusError extends BoundaryError {
  public readonly status: number;
  public readonly statusText: string;
  public readonly headers: Headers | Record<string, string | undefined>;
  public readonly response?: unknown;

  constructor(
    status: number,
    statusText: string,
    headers: Headers | Record<string, string | undefined>,
    response?: unknown
  ) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`, 'HTTP_STATUS');
    this.name = 'HttpStatusError';
    this.status = status;
    this.statusText = statusText;
    this.headers = headers;
    this.response = response;
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ECONNABORTED',
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
]);

const RETRYABLE_TRPC_CODES = new Set([
  'TIMEOUT',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseRetryAfterMs(headerValue: unknown): number | undefined {
  if (typeof headerValue === 'number' && Number.isFinite(headerValue) && headerValue >= 0) {
    return headerValue * 1000;
  }
  if (typeof headerValue !== 'string') {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return undefined;
  }
  const numericSeconds = Number(trimmed);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.round(numericSeconds * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return undefined;
}

function readHeaderValue(headers: unknown, key: string): unknown {
  if (!headers) {
    return undefined;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(key) ?? undefined;
  }
  if (isRecord(headers)) {
    const getFn = headers['get'];
    if (typeof getFn === 'function') {
      const value = (getFn as (name: string) => unknown).call(headers, key);
      if (value !== null && value !== undefined) {
        return value;
      }
    }
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lowerKey) {
        return v;
      }
    }
  }
  return undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (typeof error['status'] === 'number') {
    return error['status'];
  }
  if (typeof error['statusCode'] === 'number') {
    return error['statusCode'];
  }
  const response = error['response'];
  if (isRecord(response) && typeof response['status'] === 'number') {
    return response['status'];
  }
  const data = error['data'];
  if (isRecord(data) && typeof data['httpStatus'] === 'number') {
    return data['httpStatus'];
  }
  const shape = error['shape'];
  if (isRecord(shape)) {
    const shapeData = shape['data'];
    if (isRecord(shapeData) && typeof shapeData['httpStatus'] === 'number') {
      return shapeData['httpStatus'];
    }
  }
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (typeof error['retryAfterMs'] === 'number' && Number.isFinite(error['retryAfterMs'])) {
    return Math.max(0, error['retryAfterMs']);
  }
  const directHeader = readHeaderValue(error['headers'], 'retry-after');
  const directParsed = parseRetryAfterMs(directHeader);
  if (directParsed !== undefined) {
    return directParsed;
  }
  const response = error['response'];
  if (isRecord(response)) {
    const responseHeader = readHeaderValue(response['headers'], 'retry-after');
    const responseParsed = parseRetryAfterMs(responseHeader);
    if (responseParsed !== undefined) {
      return responseParsed;
    }
  }
  const meta = error['meta'];
  if (isRecord(meta) && isRecord(meta['response'])) {
    const metaHeader = readHeaderValue(meta['response']['headers'], 'retry-after');
    const metaParsed = parseRetryAfterMs(metaHeader);
    if (metaParsed !== undefined) {
      return metaParsed;
    }
  }
  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (typeof error['code'] === 'string') {
    return error['code'];
  }
  const data = error['data'];
  if (isRecord(data) && typeof data['code'] === 'string') {
    return data['code'];
  }
  const cause = error['cause'];
  if (isRecord(cause) && typeof cause['code'] === 'string') {
    return cause['code'];
  }
  return undefined;
}

function isNetworkMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('failed to fetch') ||
    lower.includes('fetch failed') ||
    lower.includes('networkerror') ||
    lower.includes('network error') ||
    lower.includes('network request failed') ||
    lower.includes('load failed') ||
    lower.includes('socket hang up') ||
    lower.includes('connection reset') ||
    lower.includes('offline')
  );
}

export function defaultClassifyError(error: unknown): ErrorClassification {
  if (error instanceof BoundaryAbortError) {
    return {
      retryable: false,
      authExpired: false,
      rateLimited: false,
      networkDrop: false
    };
  }

  if (error instanceof BoundaryTimeoutError) {
    return {
      retryable: error.scope === 'attempt',
      authExpired: false,
      rateLimited: false,
      networkDrop: true
    };
  }

  if (error instanceof CircuitOpenError) {
    return {
      retryable: false,
      authExpired: false,
      rateLimited: false,
      networkDrop: false
    };
  }

  if (isRecord(error) && error['name'] === 'AbortError') {
    return {
      retryable: false,
      authExpired: false,
      rateLimited: false,
      networkDrop: false
    };
  }

  const statusCode = extractStatusCode(error);
  const retryAfterMs = extractRetryAfterMs(error);
  const errorCode = extractErrorCode(error);

  const authExpired =
    statusCode === 401 ||
    errorCode === 'UNAUTHORIZED' ||
    errorCode === 'TOKEN_EXPIRED';

  const rateLimited =
    statusCode === 429 || errorCode === 'TOO_MANY_REQUESTS';

  const message =
    error instanceof Error
      ? error.message
      : isRecord(error) && typeof error['message'] === 'string'
        ? error['message']
        : '';

  const networkDrop =
    (errorCode !== undefined && RETRYABLE_NETWORK_CODES.has(errorCode)) ||
    isNetworkMessage(message);

  const trpcRetryable =
    errorCode !== undefined && RETRYABLE_TRPC_CODES.has(errorCode);

  const statusRetryable =
    statusCode !== undefined && RETRYABLE_HTTP_STATUSES.has(statusCode);

  const retryable = networkDrop || rateLimited || statusRetryable || trpcRetryable;

  const classification: ErrorClassification = {
    retryable,
    authExpired,
    rateLimited,
    networkDrop
  };

  if (statusCode !== undefined) {
    classification.statusCode = statusCode;
  }
  if (retryAfterMs !== undefined) {
    classification.retryAfterMs = retryAfterMs;
  }

  return classification;
}
