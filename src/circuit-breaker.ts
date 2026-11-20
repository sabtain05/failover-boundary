import type { CircuitBreakerOptions, CircuitState } from './types.js';

export interface CircuitTransition {
  from: CircuitState;
  to: CircuitState;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.resetTimeoutMs = Math.max(1, options.resetTimeoutMs);
    this.halfOpenMaxAttempts = Math.max(1, options.halfOpenMaxAttempts ?? 1);
  }

  public getState(): CircuitState {
    return this.state;
  }

  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  public getNextAttemptAt(): number {
    return this.openedAt + this.resetTimeoutMs;
  }

  public canExecute(now = Date.now()): { allowed: boolean; transition?: CircuitTransition } {
    if (this.state === 'closed') {
      return { allowed: true };
    }

    if (this.state === 'open') {
      if (now - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenInFlight = 1;
        return {
          allowed: true,
          transition: { from: 'open', to: 'half-open' }
        };
      }
      return { allowed: false };
    }

    if (this.halfOpenInFlight < this.halfOpenMaxAttempts) {
      this.halfOpenInFlight += 1;
      return { allowed: true };
    }

    return { allowed: false };
  }

  public recordSuccess(): CircuitTransition | undefined {
    const previous = this.state;
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = 0;
    this.state = 'closed';
    if (previous !== 'closed') {
      return { from: previous, to: 'closed' };
    }
    return undefined;
  }

  public recordFailure(now = Date.now()): CircuitTransition | undefined {
    const previous = this.state;
    this.consecutiveFailures += 1;

    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      this.halfOpenInFlight = 0;
      return { from: previous, to: 'open' };
    }

    if (this.consecutiveFailures >= this.failureThreshold && this.state === 'closed') {
      this.state = 'open';
      this.openedAt = now;
      return { from: previous, to: 'open' };
    }

    return undefined;
  }

  public reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = 0;
  }
}
