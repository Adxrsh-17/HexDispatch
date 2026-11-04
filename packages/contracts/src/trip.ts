export const TRIP_STATES = [
  'REQUESTED',
  'MATCHING',
  'OFFERED',
  'ASSIGNED',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED_BY_RIDER',
  'CANCELLED_BY_DRIVER',
  'NO_DRIVER_FOUND',
  'FAILED',
] as const;

export type TripState = (typeof TRIP_STATES)[number];

/** Enum-style accessor: `TripState.ASSIGNED`. */
export const TripState = {
  REQUESTED: 'REQUESTED',
  MATCHING: 'MATCHING',
  OFFERED: 'OFFERED',
  ASSIGNED: 'ASSIGNED',
  DRIVER_ARRIVED: 'DRIVER_ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED_BY_RIDER: 'CANCELLED_BY_RIDER',
  CANCELLED_BY_DRIVER: 'CANCELLED_BY_DRIVER',
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
  FAILED: 'FAILED',
} as const satisfies Record<TripState, TripState>;

export const TERMINAL_TRIP_STATES = [
  'COMPLETED',
  'CANCELLED_BY_RIDER',
  'CANCELLED_BY_DRIVER',
  'NO_DRIVER_FOUND',
  'FAILED',
] as const satisfies readonly TripState[];

export type TripActor = 'RIDER' | 'DRIVER' | 'SYSTEM' | 'ADMIN';

/** One legal edge of the trip state machine. */
export interface TripTransition {
  readonly from: TripState;
  readonly to: TripState;
  /** Who may trigger this edge. */
  readonly actors: readonly TripActor[];
}

/**
 * The state machine is ONE table of these rows, owned by core-api (Phase 1).
 * Only types live here so other services can reason about states without the logic.
 */
export type TripTransitionTable = readonly TripTransition[];

export function isTerminalTripState(state: TripState): boolean {
  return (TERMINAL_TRIP_STATES as readonly TripState[]).includes(state);
}
