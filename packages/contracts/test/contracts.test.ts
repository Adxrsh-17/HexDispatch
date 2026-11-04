import { describe, expect, it } from 'vitest';
import {
  TERMINAL_TRIP_STATES,
  TOPICS,
  TOPIC_KEY,
  TRIP_STATES,
  TripState,
  isTerminalTripState,
  tripStateChangedEvent,
} from '../src';

describe('contracts', () => {
  it('every topic has a documented key', () => {
    for (const topic of Object.values(TOPICS)) {
      expect(TOPIC_KEY[topic]).toBeTruthy();
    }
  });

  it('TripState const matches the tuple', () => {
    expect(Object.values(TripState).sort()).toEqual([...TRIP_STATES].sort());
  });

  it('terminal states are flagged terminal, others are not', () => {
    for (const s of TRIP_STATES) {
      expect(isTerminalTripState(s)).toBe((TERMINAL_TRIP_STATES as readonly string[]).includes(s));
    }
  });

  it('validates a trip.state.changed event', () => {
    const ok = tripStateChangedEvent.safeParse({
      eventId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      type: 'trip.state.changed',
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'c-1',
      payload: {
        rideId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
        from: null,
        to: 'REQUESTED',
        version: 0,
        actor: 'RIDER',
      },
    });
    expect(ok.success).toBe(true);
  });
});
