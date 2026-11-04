import { Counter, Gauge, type Registry } from 'prom-client';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  name: string;
  failureThreshold?: number; // consecutive failures before opening (default 5)
  resetTimeoutMs?: number; // time to stay OPEN before HALF_OPEN test (default 5000ms)
  timeoutMs?: number; // per-call timeout (default 3000ms)
  successThreshold?: number; // consecutive successes in HALF_OPEN to close (default 2)
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  registry?: Registry;
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker '${name}' is OPEN`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreakerTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`Circuit breaker '${name}' call timed out after ${timeoutMs}ms`);
    this.name = 'CircuitBreakerTimeoutError';
  }
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitState = 'CLOSED';
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private timeoutMs: number;
  private successThreshold: number;

  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private lastStateChangedAt = Date.now();
  private onStateChange?: (from: CircuitState, to: CircuitState) => void;
  private stateGauge?: Gauge<string>;
  private stateChangesCounter?: Counter<string>;

  constructor(config: CircuitBreakerConfig) {
    this.name = config.name;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 5000;
    this.timeoutMs = config.timeoutMs ?? 3000;
    this.successThreshold = config.successThreshold ?? 2;
    this.onStateChange = config.onStateChange;

    if (config.registry) {
      this.stateGauge =
        (config.registry.getSingleMetric('circuit_breaker_state') as Gauge<string>) ??
        new Gauge({
          name: 'circuit_breaker_state',
          help: 'Current state of circuit breaker: 0=CLOSED, 1=HALF_OPEN, 2=OPEN',
          labelNames: ['name'] as const,
          registers: [config.registry],
        });

      this.stateChangesCounter =
        (config.registry.getSingleMetric(
          'circuit_breaker_state_changes_total',
        ) as Counter<string>) ??
        new Counter({
          name: 'circuit_breaker_state_changes_total',
          help: 'Total count of circuit breaker state transitions',
          labelNames: ['name', 'from', 'to'] as const,
          registers: [config.registry],
        });

      this.stateGauge.labels(this.name).set(0);
    }
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastStateChangedAt >= this.resetTimeoutMs) {
        this.transitionTo('HALF_OPEN');
      }
    }
    return this.state;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangedAt = Date.now();

    if (newState === 'CLOSED') {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
    }

    if (this.onStateChange) {
      this.onStateChange(oldState, newState);
    }

    if (this.stateChangesCounter) {
      this.stateChangesCounter.labels(this.name, oldState, newState).inc();
    }
    if (this.stateGauge) {
      const code = newState === 'CLOSED' ? 0 : newState === 'HALF_OPEN' ? 1 : 2;
      this.stateGauge.labels(this.name).set(code);
    }
  }

  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T> | T): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      if (fallback) {
        return fallback();
      }
      throw new CircuitBreakerOpenError(this.name);
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CircuitBreakerTimeoutError(this.name, this.timeoutMs));
      }, this.timeoutMs);
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      if (timer) clearTimeout(timer);
      this.onSuccess();
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      this.onFailure();
      if (fallback) {
        return fallback();
      }
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.successThreshold) {
        this.transitionTo('CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN immediately re-opens the breaker
      this.transitionTo('OPEN');
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo('OPEN');
      }
    }
  }

  reset(): void {
    this.transitionTo('CLOSED');
  }
}
