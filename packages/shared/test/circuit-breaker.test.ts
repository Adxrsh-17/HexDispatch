import { describe, it, expect, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitBreakerTimeoutError,
  type CircuitState,
} from '../src/circuit-breaker';

describe('Circuit Breaker (AC3)', () => {
  it('covers the complete CLOSED -> OPEN -> HALF_OPEN -> CLOSED cycle', async () => {
    const transitions: Array<{ from: CircuitState; to: CircuitState }> = [];
    const cb = new CircuitBreaker({
      name: 'test-service',
      failureThreshold: 3,
      resetTimeoutMs: 50, // 50ms for fast test
      timeoutMs: 500,
      successThreshold: 2,
      onStateChange: (from, to) => {
        transitions.push({ from, to });
      },
    });

    // 1. Initial state is CLOSED
    expect(cb.getState()).toBe('CLOSED');

    // 2. Successful call in CLOSED
    const ok = await cb.execute(async () => 'success');
    expect(ok).toBe('success');
    expect(cb.getState()).toBe('CLOSED');

    // 3. Trigger 3 consecutive failures to open the circuit
    const failFn = async () => {
      throw new Error('Downstream failure');
    };

    await expect(cb.execute(failFn)).rejects.toThrow('Downstream failure');
    await expect(cb.execute(failFn)).rejects.toThrow('Downstream failure');
    expect(cb.getState()).toBe('CLOSED');

    // 3rd failure opens the breaker
    await expect(cb.execute(failFn)).rejects.toThrow('Downstream failure');
    expect(cb.getState()).toBe('OPEN');
    expect(transitions).toContainEqual({ from: 'CLOSED', to: 'OPEN' });

    // 4. Calls while OPEN fail fast with CircuitBreakerOpenError without calling fn
    const spy = vi.fn();
    await expect(cb.execute(spy)).rejects.toThrow(CircuitBreakerOpenError);
    expect(spy).not.toHaveBeenCalled();

    // Or uses fallback if provided
    const fallbackRes = await cb.execute(spy, () => 'fallback-value');
    expect(fallbackRes).toBe('fallback-value');
    expect(spy).not.toHaveBeenCalled();

    // 5. Wait for resetTimeoutMs -> transitions to HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cb.getState()).toBe('HALF_OPEN');

    // 6. First successful test in HALF_OPEN
    const test1 = await cb.execute(async () => 'recovered-1');
    expect(test1).toBe('recovered-1');
    expect(cb.getState()).toBe('HALF_OPEN'); // needs 2 successes to close

    // 7. Second successful test in HALF_OPEN -> transitions back to CLOSED
    const test2 = await cb.execute(async () => 'recovered-2');
    expect(test2).toBe('recovered-2');
    expect(cb.getState()).toBe('CLOSED');
    expect(transitions).toContainEqual({ from: 'HALF_OPEN', to: 'CLOSED' });
  });

  it('re-opens immediately if a call fails while in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({
      name: 'flaky-service',
      failureThreshold: 2,
      resetTimeoutMs: 30,
      timeoutMs: 500,
    });

    await expect(
      cb.execute(async () => {
        throw new Error('fail 1');
      }),
    ).rejects.toThrow();
    await expect(
      cb.execute(async () => {
        throw new Error('fail 2');
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(cb.getState()).toBe('HALF_OPEN');

    // Failure during HALF_OPEN should immediately kick it back to OPEN
    await expect(
      cb.execute(async () => {
        throw new Error('still broken');
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');
  });

  it('times out calls exceeding timeoutMs', async () => {
    const cb = new CircuitBreaker({
      name: 'slow-service',
      timeoutMs: 40,
    });

    const slowFn = () => new Promise((resolve) => setTimeout(resolve, 100));
    await expect(cb.execute(slowFn)).rejects.toThrow(CircuitBreakerTimeoutError);
  });

  it('records Prometheus metrics for state transitions', async () => {
    const { Registry } = await import('prom-client');
    const registry = new Registry();

    const cb = new CircuitBreaker({
      name: 'metrics-service',
      failureThreshold: 1,
      resetTimeoutMs: 20,
      registry,
    });

    await expect(
      cb.execute(async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow();
    expect(cb.getState()).toBe('OPEN');

    const metricsStr = await registry.metrics();
    expect(metricsStr).toContain('circuit_breaker_state{name="metrics-service"} 2');
    expect(metricsStr).toContain(
      'circuit_breaker_state_changes_total{name="metrics-service",from="CLOSED",to="OPEN"} 1',
    );
  });
});
