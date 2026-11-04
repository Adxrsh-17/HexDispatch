import { describe, it, expect } from 'vitest';
import { PriorityQueue } from '../src/engine/priority-queue';
import { DiscreteEngine } from '../src/engine/discrete-engine';

describe('Discrete-Event Engine & Priority Queue (Task 2)', () => {
  it('correctly orders events by time in min-heap', () => {
    const pq = new PriorityQueue<{ time: number; seq: number; label: string }>();

    pq.push({ time: 100, seq: 1, label: 'C' });
    pq.push({ time: 10, seq: 2, label: 'A' });
    pq.push({ time: 50, seq: 3, label: 'B' });

    expect(pq.pop()?.label).toBe('A');
    expect(pq.pop()?.label).toBe('B');
    expect(pq.pop()?.label).toBe('C');
    expect(pq.isEmpty()).toBe(true);
  });

  it('provides deterministic tie-breaking by monotonic sequence number for simultaneous events', () => {
    const pq = new PriorityQueue<{ time: number; seq: number; label: string }>();

    pq.push({ time: 50, seq: 3, label: 'third' });
    pq.push({ time: 50, seq: 1, label: 'first' });
    pq.push({ time: 50, seq: 2, label: 'second' });

    expect(pq.pop()?.label).toBe('first');
    expect(pq.pop()?.label).toBe('second');
    expect(pq.pop()?.label).toBe('third');
  });

  it('runs discrete engine stepping forward monotonically in time', () => {
    const engine = new DiscreteEngine();
    const trace: string[] = [];

    engine.on('RIDE_REQUESTED', (e) => {
      trace.push(`req@${e.time}`);
    });
    engine.on('DRIVER_ONLINE', (e) => {
      trace.push(`drv@${e.time}`);
    });

    engine.schedule('DRIVER_ONLINE', 10, {});
    engine.schedule('RIDE_REQUESTED', 5, {});
    engine.schedule('RIDE_REQUESTED', 20, {});

    engine.runUntil(15);
    expect(trace).toEqual(['req@5', 'drv@10']);
    expect(engine.now).toBe(15);

    engine.runUntil(30);
    expect(trace).toEqual(['req@5', 'drv@10', 'req@20']);
  });
});
