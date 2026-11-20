import type { BackoffContext, BackoffStrategy, JitterMode } from './types.js';

export interface BackoffComputeInput {
  attempt: number;
  strategy: BackoffStrategy;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitter: JitterMode;
  previousDelayMs: number;
  retryAfterMs?: number;
  respectRetryAfter: boolean;
  random: () => number;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function applyJitter(delayMs: number, jitter: JitterMode, random: () => number): number {
  if (delayMs <= 0 || jitter === 'none') {
    return delayMs;
  }
  const sample = clamp(random(), 0, 1);
  if (jitter === 'full') {
    return Math.round(sample * delayMs);
  }
  const half = delayMs / 2;
  return Math.round(half + sample * half);
}

export function computeBackoffDelay(input: BackoffComputeInput): number {
  const {
    attempt,
    strategy,
    baseDelayMs,
    maxDelayMs,
    backoffFactor,
    jitter,
    previousDelayMs,
    retryAfterMs,
    respectRetryAfter,
    random
  } = input;

  const safeBase = Math.max(0, baseDelayMs);
  const safeMax = Math.max(safeBase, maxDelayMs);
  const safeFactor = backoffFactor > 0 ? backoffFactor : 2;
  const safeAttempt = Math.max(1, attempt);

  let delay: number;

  if (typeof strategy === 'function') {
    const context: BackoffContext = {
      attempt: safeAttempt,
      baseDelayMs: safeBase,
      maxDelayMs: safeMax,
      backoffFactor: safeFactor,
      previousDelayMs
    };
    if (retryAfterMs !== undefined) {
      context.retryAfterMs = retryAfterMs;
    }
    delay = clamp(strategy(safeAttempt, context), 0, safeMax);
  } else if (strategy === 'fixed') {
    delay = applyJitter(Math.min(safeBase, safeMax), jitter, random);
  } else if (strategy === 'linear') {
    const raw = Math.min(safeMax, safeBase * safeAttempt);
    delay = applyJitter(raw, jitter, random);
  } else if (strategy === 'decorrelated-jitter') {
    const prev = previousDelayMs > 0 ? previousDelayMs : safeBase;
    const upper = Math.min(safeMax, Math.max(safeBase, prev * 3));
    const sample = clamp(random(), 0, 1);
    delay = Math.round(safeBase + sample * (upper - safeBase));
  } else {
    const raw = Math.min(safeMax, safeBase * Math.pow(safeFactor, safeAttempt - 1));
    delay = applyJitter(raw, jitter, random);
  }

  if (respectRetryAfter && retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    const boundedRetryAfter = clamp(retryAfterMs, 0, safeMax);
    delay = Math.max(delay, boundedRetryAfter);
  }

  return Math.round(clamp(delay, 0, safeMax));
}
