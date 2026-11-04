import {
  type MatchingPolicy,
  type RideRequest,
  type DriverCandidate,
  type MatchContext,
  GreedyPolicy,
  DEFAULT_MATCHING_CONFIG,
  haversineMeters,
  type LatLng,
} from '@hexdispatch/matching';
import { DiscreteEngine } from './engine/discrete-engine';
import {
  type SimEvent,
  type RideRequestedPayload,
  type RetryMatchPayload,
  type OfferEvaluatePayload,
  type OfferTimeoutPayload,
  type DriverArrivePickupPayload,
  type TripStartPayload,
  type TripCompletePayload,
  type DriverRoamPayload,
} from './engine/event';
import { RngManager } from './rng/rng-manager';
import { CityModel } from './models/city';
import { DemandModel } from './models/demand';
import { SimDriver } from './models/driver';
import { MetricsCollector, type SimMetrics } from './metrics/collector';
import type { ScenarioConfig } from './scenarios/types';

interface ActiveRide {
  id: string;
  pickup: LatLng;
  dropoff: LatLng;
  requestedAtSec: number;
  matchedAtSec?: number;
  pickupEtaSec?: number;
  assignedDriverId?: string;
  attempts: number;
  excludedDrivers: Set<string>;
  activeOfferId?: string;
}

export interface SimulationResult {
  scenario: ScenarioConfig;
  policy: MatchingPolicy;
  seed: number;
  metrics: SimMetrics;
  drivers: readonly SimDriver[];
  collector: MetricsCollector;
}

export class CitySimulator {
  private engine = new DiscreteEngine();
  private rng: RngManager;
  private city: CityModel;
  private demand: DemandModel;
  private drivers = new Map<string, SimDriver>();
  private activeRides = new Map<string, ActiveRide>();
  private collector = new MetricsCollector();
  private policy: MatchingPolicy;

  private offerTimeoutSec: number;
  private maxOfferAttempts: number;
  private nextOfferId = 0;
  private nextRideId = 0;

  constructor(
    readonly scenario: ScenarioConfig,
    readonly seed: number,
    policy?: MatchingPolicy,
  ) {
    this.rng = new RngManager(seed);
    this.city = new CityModel(scenario.city);
    this.demand = new DemandModel(scenario.demand);
    this.policy = policy ?? new GreedyPolicy();

    this.offerTimeoutSec = scenario.matching?.offerTimeoutSec ?? 15;
    this.maxOfferAttempts = scenario.matching?.maxOfferAttempts ?? 3;

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // 1. RIDE_REQUESTED
    this.engine.on<RideRequestedPayload>('RIDE_REQUESTED', (event) => {
      this.handleRideRequested(event);
    });

    // 2. RETRY_MATCH
    this.engine.on<RetryMatchPayload>('RETRY_MATCH', (event) => {
      const ride = this.activeRides.get(event.payload.rideId);
      if (ride && !ride.activeOfferId && !ride.assignedDriverId) {
        this.dispatchRide(ride, event.time);
      }
    });

    // 3. OFFER_EVALUATE
    this.engine.on<OfferEvaluatePayload>('OFFER_EVALUATE', (event) => {
      this.handleOfferEvaluate(event);
    });

    // 4. OFFER_TIMEOUT
    this.engine.on<OfferTimeoutPayload>('OFFER_TIMEOUT', (event) => {
      this.handleOfferTimeout(event);
    });

    // 5. DRIVER_ARRIVE_PICKUP
    this.engine.on<DriverArrivePickupPayload>('DRIVER_ARRIVE_PICKUP', (event) => {
      this.handleDriverArrivePickup(event);
    });

    // 6. TRIP_START
    this.engine.on<TripStartPayload>('TRIP_START', (event) => {
      this.handleTripStart(event);
    });

    // 7. TRIP_COMPLETE
    this.engine.on<TripCompletePayload>('TRIP_COMPLETE', (event) => {
      this.handleTripComplete(event);
    });

    // 8. DRIVER_ROAM
    this.engine.on<DriverRoamPayload>('DRIVER_ROAM', (event) => {
      this.handleDriverRoam(event);
    });
  }

  private initializeFleet(): void {
    const { count, baseAcceptanceRate } = this.scenario.drivers;
    for (let i = 1; i <= count; i++) {
      const driverId = `drv-${i.toString().padStart(3, '0')}`;
      const initialLocation = this.city.randomPointInCity(this.rng.driver, true);

      const driver = new SimDriver({
        id: driverId,
        initialLocation,
        shiftStartSec: 0,
        shiftEndSec: this.scenario.durationSec,
        baseAcceptanceRate,
      });

      driver.transitionStatus('IDLE', 0);
      this.drivers.set(driverId, driver);

      // Schedule initial roaming check
      const roamDelay = this.rng.driver.nextFloat(30, 90);
      this.engine.schedule<DriverRoamPayload>('DRIVER_ROAM', roamDelay, { driverId });
    }
  }

  private scheduleNextRide(currentTimeSec: number): void {
    if (currentTimeSec >= this.scenario.durationSec) return;

    const deltaSec = this.demand.sampleInterArrivalTimeSec(currentTimeSec, this.rng.demand);
    const scheduledTime = currentTimeSec + deltaSec;

    if (scheduledTime > this.scenario.durationSec) return;

    this.nextRideId += 1;
    const rideId = `ride-${this.nextRideId.toString().padStart(5, '0')}`;
    const ride = this.demand.generateRide(rideId, scheduledTime, this.city, this.rng.demand);

    this.engine.scheduleAt<RideRequestedPayload>('RIDE_REQUESTED', scheduledTime, {
      rideId: ride.id,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
    });
  }

  private handleRideRequested(event: SimEvent<RideRequestedPayload>): void {
    const { rideId, pickup, dropoff } = event.payload;
    this.collector.recordRequest();

    const ride: ActiveRide = {
      id: rideId,
      pickup,
      dropoff,
      requestedAtSec: event.time,
      attempts: 0,
      excludedDrivers: new Set<string>(),
    };
    this.activeRides.set(rideId, ride);

    // Schedule subsequent demand arrival
    this.scheduleNextRide(event.time);

    // Run matching for this ride
    this.dispatchRide(ride, event.time);
  }

  private dispatchRide(ride: ActiveRide, currentTimeSec: number): boolean {
    if (ride.attempts >= this.maxOfferAttempts) {
      this.collector.recordUnmatchedRide({
        rideId: ride.id,
        requestedAtSec: ride.requestedAtSec,
        attempts: ride.attempts,
        reason: 'MAX_ATTEMPTS_EXCEEDED',
      });
      this.activeRides.delete(ride.id);
      return false;
    }

    // 1. Gather available IDLE drivers within max pickup distance
    const candidates: DriverCandidate[] = [];
    const maxDistanceMeters = DEFAULT_MATCHING_CONFIG.maxPickupEtaSec * this.city.baseSpeedMps;

    for (const d of this.drivers.values()) {
      if (d.status !== 'IDLE') continue;
      if (ride.excludedDrivers.has(d.id)) continue;

      const dist = haversineMeters(d.location, ride.pickup);
      if (dist <= maxDistanceMeters) {
        candidates.push({
          id: d.id,
          location: d.location,
          idleSinceMs: d.idleSinceSec * 1000,
        });
      }
    }

    if (candidates.length === 0) {
      ride.attempts += 1;
      if (ride.attempts >= this.maxOfferAttempts) {
        this.collector.recordUnmatchedRide({
          rideId: ride.id,
          requestedAtSec: ride.requestedAtSec,
          attempts: ride.attempts,
          reason: 'NO_DRIVER_FOUND',
        });
        this.activeRides.delete(ride.id);
        return false;
      }

      // Retry matching in 5 seconds
      this.engine.schedule<RetryMatchPayload>('RETRY_MATCH', 5, { rideId: ride.id });
      return false;
    }

    // 2. Call MatchingPolicy (from packages/matching)
    const request: RideRequest = {
      id: ride.id,
      pickup: ride.pickup,
      requestedAtMs: ride.requestedAtSec * 1000,
      excludedDriverIds: Array.from(ride.excludedDrivers),
    };

    const ctx: MatchContext = {
      nowMs: currentTimeSec * 1000,
      config: {
        speedMps: this.city.baseSpeedMps * this.city.speedMultiplier,
        maxPickupEtaSec: DEFAULT_MATCHING_CONFIG.maxPickupEtaSec,
      },
    };

    const result = this.policy.match([request], candidates, ctx);
    if (result.assignments.length === 0) {
      ride.attempts += 1;
      if (ride.attempts >= this.maxOfferAttempts) {
        this.collector.recordUnmatchedRide({
          rideId: ride.id,
          requestedAtSec: ride.requestedAtSec,
          attempts: ride.attempts,
          reason: 'NO_DRIVER_FOUND',
        });
        this.activeRides.delete(ride.id);
        return false;
      }

      this.engine.schedule<RetryMatchPayload>('RETRY_MATCH', 5, { rideId: ride.id });
      return false;
    }

    // 3. Make offer to best assignment
    const assignment = result.assignments[0]!;
    const driver = this.drivers.get(assignment.driverId)!;
    this.nextOfferId += 1;
    const offerId = `off-${this.nextOfferId}`;

    ride.attempts += 1;
    ride.activeOfferId = offerId;
    ride.assignedDriverId = driver.id;
    ride.matchedAtSec = currentTimeSec;
    ride.pickupEtaSec = assignment.pickupEtaSec;

    driver.transitionStatus('ON_OFFER', currentTimeSec);
    driver.currentOfferId = offerId;
    driver.currentRideId = ride.id;

    // Driver decision from acceptance model
    const decision = driver.evaluateOffer(
      assignment.pickupEtaSec,
      this.offerTimeoutSec,
      this.rng.acceptance,
    );

    if (decision.isTimeout) {
      // Schedule timeout event
      this.engine.schedule<OfferTimeoutPayload>('OFFER_TIMEOUT', this.offerTimeoutSec, {
        offerId,
        rideId: ride.id,
        driverId: driver.id,
      });
    } else {
      // Schedule evaluate event with decision delay
      this.engine.schedule<OfferEvaluatePayload>('OFFER_EVALUATE', decision.responseDelaySec, {
        offerId,
        rideId: ride.id,
        driverId: driver.id,
        accepted: decision.accept,
      });
    }

    return true;
  }

  private handleOfferEvaluate(event: SimEvent<OfferEvaluatePayload>): void {
    const { offerId, rideId, driverId, accepted } = event.payload;
    const ride = this.activeRides.get(rideId);
    const driver = this.drivers.get(driverId);

    if (!ride || !driver || ride.activeOfferId !== offerId) return;

    if (accepted) {
      // Driver ACCEPTED offer
      driver.acceptedOffers += 1;
      driver.transitionStatus('DISPATCHED', event.time);

      const pickupTravelTimeSec = this.city.getTravelTimeSec(driver.location, ride.pickup);
      this.engine.schedule<DriverArrivePickupPayload>('DRIVER_ARRIVE_PICKUP', pickupTravelTimeSec, {
        rideId,
        driverId,
      });
    } else {
      // Driver DECLINED offer
      driver.declinedOffers += 1;
      driver.transitionStatus('IDLE', event.time);
      driver.currentOfferId = undefined;
      driver.currentRideId = undefined;

      ride.excludedDrivers.add(driverId);
      ride.activeOfferId = undefined;
      ride.assignedDriverId = undefined;

      // Re-offer to next candidate
      this.dispatchRide(ride, event.time);
    }
  }

  private handleOfferTimeout(event: SimEvent<OfferTimeoutPayload>): void {
    const { offerId, rideId, driverId } = event.payload;
    const ride = this.activeRides.get(rideId);
    const driver = this.drivers.get(driverId);

    if (!ride || !driver || ride.activeOfferId !== offerId) return;

    driver.timedOutOffers += 1;
    driver.transitionStatus('IDLE', event.time);
    driver.currentOfferId = undefined;
    driver.currentRideId = undefined;

    ride.excludedDrivers.add(driverId);
    ride.activeOfferId = undefined;
    ride.assignedDriverId = undefined;

    // Re-offer
    this.dispatchRide(ride, event.time);
  }

  private handleDriverArrivePickup(event: SimEvent<DriverArrivePickupPayload>): void {
    const { rideId, driverId } = event.payload;
    const ride = this.activeRides.get(rideId);
    const driver = this.drivers.get(driverId);
    if (!ride || !driver) return;

    driver.location = { ...ride.pickup };
    // Boarding delay: 15 seconds
    this.engine.schedule<TripStartPayload>('TRIP_START', 15, { rideId, driverId });
  }

  private handleTripStart(event: SimEvent<TripStartPayload>): void {
    const { rideId, driverId } = event.payload;
    const ride = this.activeRides.get(rideId);
    const driver = this.drivers.get(driverId);
    if (!ride || !driver) return;

    driver.transitionStatus('ON_TRIP', event.time);
    const tripDurationSec = this.city.getTravelTimeSec(ride.pickup, ride.dropoff);

    this.engine.schedule<TripCompletePayload>('TRIP_COMPLETE', tripDurationSec, {
      rideId,
      driverId,
      fare: 0,
    });
  }

  private handleTripComplete(event: SimEvent<TripCompletePayload>): void {
    const { rideId, driverId } = event.payload;
    const ride = this.activeRides.get(rideId);
    const driver = this.drivers.get(driverId);
    if (!ride || !driver) return;

    const { fareCents } = driver.completeTrip(ride.pickup, ride.dropoff, event.time);

    this.collector.recordCompletedRide({
      rideId: ride.id,
      driverId: driver.id,
      requestedAtSec: ride.requestedAtSec,
      matchedAtSec: ride.matchedAtSec ?? event.time,
      pickupEtaSec: ride.pickupEtaSec ?? 0,
      pickupArrivedAtSec: event.time,
      completedAtSec: event.time,
      tripDurationSec: event.time - (ride.matchedAtSec ?? event.time),
      fareCents,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
    });

    this.activeRides.delete(rideId);

    // If there are waiting unmatched rides, check if any can match this newly idle driver
    for (const waitingRide of this.activeRides.values()) {
      if (!waitingRide.activeOfferId && !waitingRide.assignedDriverId) {
        if (!waitingRide.excludedDrivers.has(driver.id)) {
          const dist = haversineMeters(driver.location, waitingRide.pickup);
          if (dist <= DEFAULT_MATCHING_CONFIG.maxPickupEtaSec * this.city.baseSpeedMps) {
            this.dispatchRide(waitingRide, event.time);
            break;
          }
        }
      }
    }

    // Schedule next roaming check
    const roamDelay = this.rng.driver.nextFloat(30, 90);
    this.engine.schedule<DriverRoamPayload>('DRIVER_ROAM', roamDelay, { driverId });
  }

  private handleDriverRoam(event: SimEvent<DriverRoamPayload>): void {
    const { driverId } = event.payload;
    const driver = this.drivers.get(driverId);
    if (!driver || driver.status !== 'IDLE') return;

    driver.roam(this.city, this.rng.driver, event.time);

    // Periodic roaming check every 60-120 seconds
    const nextRoam = this.rng.driver.nextFloat(60, 120);
    this.engine.schedule<DriverRoamPayload>('DRIVER_ROAM', nextRoam, { driverId });
  }

  run(): SimulationResult {
    this.initializeFleet();
    // Schedule first passenger ride
    this.scheduleNextRide(0);

    // Run discrete event loop
    this.engine.runUntil(this.scenario.durationSec);

    const driversList = Array.from(this.drivers.values());
    const metrics = this.collector.calculate(driversList, this.scenario.durationSec);

    return {
      scenario: this.scenario,
      policy: this.policy,
      seed: this.seed,
      metrics,
      drivers: driversList,
      collector: this.collector,
    };
  }
}
