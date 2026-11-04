export interface LatLng {
  lat: number;
  lng: number;
}

export interface RideRequest {
  id: string;
  pickup: LatLng;
  /** Arrival time (ms). Greedy serves in this order; batched uses it for the wait penalty. */
  requestedAtMs: number;
  /** Drivers that declined or timed out for this ride. Never matched again for it. */
  excludedDriverIds?: readonly string[];
}

export interface DriverCandidate {
  id: string;
  location: LatLng;
  /** When the driver became idle (ms). Batched policy uses it for the idle bonus. */
  idleSinceMs: number;
}

export interface MatchingConfig {
  /** Average travel speed used for ETA, metres per second. 8.33 m/s = 30 km/h. */
  speedMps: number;
  /** A pair with a longer pickup ETA is infeasible. */
  maxPickupEtaSec: number;
}

export const DEFAULT_MATCHING_CONFIG: MatchingConfig = {
  speedMps: 8.33,
  maxPickupEtaSec: 600,
};

export interface MatchContext {
  /** Injected clock: the library never reads real time. */
  nowMs: number;
  config: MatchingConfig;
}

export interface Assignment {
  rideId: string;
  driverId: string;
  pickupEtaSec: number;
  /** Policy-defined cost of this pair (greedy: pickup ETA in seconds). */
  cost: number;
}

export interface MatchResult {
  assignments: Assignment[];
  /** Ride ids that got no driver this call. Order follows input order. */
  unmatchedRideIds: string[];
}

/**
 * A matching policy turns pending requests and available drivers into assignments.
 * Implementations must be pure and deterministic: same input -> same output.
 * Each driver appears in at most one assignment, each ride in at most one.
 */
export interface MatchingPolicy {
  readonly name: string;
  match(
    requests: readonly RideRequest[],
    drivers: readonly DriverCandidate[],
    ctx: MatchContext,
  ): MatchResult;
}
