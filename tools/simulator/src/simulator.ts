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
import { computeSurgeStep } from '@hexdispatch/pricing/surge-engine';
import { TrustEngine } from '@hexdispatch/location/trust';
import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { DiscreteEngine } from './engine/discrete-engine';
import {
  type SimEvent,
  type RideRequestedPayload,
  type MatchCyclePayload,
  type SurgeCyclePayload,
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
  surgeMultiplier?: number;
}

export interface InjectedAnomaly {
  id: string;
  type: 'IMPOSSIBLE_SPEED' | 'TELEPORT_JUMP' | 'FROZEN_GPS' | 'CANCELLATION_ABUSE';
  subjectId: string;
  timeSec: number;
}

export interface AnomalyReport {
  totalInjected: number;
  detectedCount: number;
  truePositives: number;
  falsePositives: number;
  detectionRate: number;
  falsePositiveRate: number;
  injected: InjectedAnomaly[];
}

export interface SimulationResult {
  scenario: ScenarioConfig;
  policy: MatchingPolicy;
  seed: number;
  metrics: SimMetrics;
  drivers: readonly SimDriver[];
  collector: MetricsCollector;
  anomalies?: AnomalyReport;
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
  readonly isBatched: boolean;
  readonly batchWindowSec: number;
  readonly isSurgeEnabled: boolean;
  readonly surgeIntervalSec: number;
  readonly injectAnomalies: boolean;
  private trustEngine?: TrustEngine;
  private groundTruthAnomalies: InjectedAnomaly[] = [];
  private normalEventsCount = 0;
  private surgeMultipliers = new Map<string, number>();
  private demandEvents: Array<{ timeSec: number; cell: string }> = [];
  private prevSurgeState = new Map<
    string,
    { smoothedDemand: number; smoothedSupply: number; multiplier: number }
  >();

  constructor(
    readonly scenario: ScenarioConfig,
    readonly seed: number,
    policy?: MatchingPolicy,
    batchWindowSec = 2,
    surgeEnabled?: boolean,
    injectAnomalies = false,
  ) {
    this.rng = new RngManager(seed);
    this.city = new CityModel(scenario.city);
    this.demand = new DemandModel(scenario.demand);
    this.policy = policy ?? new GreedyPolicy();
    this.isBatched = this.policy.name === 'batched';
    this.batchWindowSec = batchWindowSec;
    this.isSurgeEnabled = surgeEnabled ?? scenario.surge?.enabled ?? false;
    this.surgeIntervalSec = scenario.surge?.updateIntervalSec ?? 30;
    this.injectAnomalies = injectAnomalies;

    if (this.injectAnomalies) {
      this.trustEngine = new TrustEngine({
        maxSpeedMps: 42,
        teleportDistanceMeters: 500,
        frozenGpsThresholdSec: 300,
        cancellationThresholdCount: 4,
        cancellationWindowSec: 3600,
      });
    }

    this.offerTimeoutSec = scenario.matching?.offerTimeoutSec ?? 15;
    this.maxOfferAttempts = scenario.matching?.maxOfferAttempts ?? 3;

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // 1. RIDE_REQUESTED
    this.engine.on<RideRequestedPayload>('RIDE_REQUESTED', (event) => {
      this.handleRideRequested(event);
    });

    // 2. MATCH_CYCLE (for batched matching)
    this.engine.on<MatchCyclePayload>('MATCH_CYCLE', (event) => {
      this.handleMatchCycle(event);
    });

    // 3. SURGE_CYCLE (for dynamic pricing and surge)
    this.engine.on<SurgeCyclePayload>('SURGE_CYCLE', (event) => {
      this.handleSurgeCycle(event);
    });

    // 4. RETRY_MATCH
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

    // H3 res 8 cell for pickup
    const pickupCell = latLngToCell(pickup.lat, pickup.lng, 8);
    this.demandEvents.push({ timeSec: event.time, cell: pickupCell });

    if (this.injectAnomalies && this.trustEngine) {
      if (this.rng.demand.nextFloat(0, 1) < 0.03) {
        const anomalyId = `anom-${this.groundTruthAnomalies.length + 1}`;
        this.groundTruthAnomalies.push({
          id: anomalyId,
          type: 'CANCELLATION_ABUSE',
          subjectId: rideId,
          timeSec: event.time,
        });
        for (let i = 0; i < 4; i++) {
          void this.trustEngine.recordRideOutcome({
            subjectId: rideId,
            subjectType: 'RIDER',
            isCancelled: true,
            timestampMs: (event.time + i * 30) * 1000,
          });
        }
      } else {
        void this.trustEngine.recordRideOutcome({
          subjectId: rideId,
          subjectType: 'RIDER',
          isCancelled: false,
          timestampMs: event.time * 1000,
        });
        this.normalEventsCount += 1;
      }
    }

    const surgeMultiplier = this.isSurgeEnabled
      ? (this.surgeMultipliers.get(pickupCell) ?? 1.0)
      : 1.0;

    // Price elasticity: probability of abandoning rises with surge
    // P(abandon) = 1 - exp(-gamma * (surge - 1.0))
    if (this.isSurgeEnabled && surgeMultiplier > 1.0) {
      const elasticity = this.scenario.surge?.priceElasticity ?? 1.2;
      const pAbandon = 1 - Math.exp(-elasticity * (surgeMultiplier - 1.0));
      if (this.rng.demand.nextFloat(0, 1) < pAbandon) {
        this.collector.recordUnmatchedRide({
          rideId,
          requestedAtSec: event.time,
          attempts: 0,
          reason: 'PRICE_SURGE_ABANDONED',
        });
        this.scheduleNextRide(event.time);
        return;
      }
    }

    const ride: ActiveRide = {
      id: rideId,
      pickup,
      dropoff,
      requestedAtSec: event.time,
      attempts: 0,
      excludedDrivers: new Set<string>(),
      surgeMultiplier,
    };
    this.activeRides.set(rideId, ride);

    // Schedule subsequent demand arrival
    this.scheduleNextRide(event.time);

    // In greedy mode: match immediately on arrival
    // In batched mode: periodic MATCH_CYCLE will process pending batch
    if (!this.isBatched) {
      this.dispatchRide(ride, event.time);
    }
  }

  private handleSurgeCycle(event: SimEvent<SurgeCyclePayload>): void {
    const currentTimeSec = event.time;

    // 1. Sliding window of demand (last 300 seconds / 5 minutes)
    const windowCutoff = currentTimeSec - 300;
    this.demandEvents = this.demandEvents.filter((e) => e.timeSec >= windowCutoff);

    const demandPerCell = new Map<string, number>();
    for (const d of this.demandEvents) {
      demandPerCell.set(d.cell, (demandPerCell.get(d.cell) ?? 0) + 1);
    }

    // 2. Count IDLE drivers per H3 res 8 cell
    const supplyPerCell = new Map<string, number>();
    for (const d of this.drivers.values()) {
      if (d.status === 'IDLE') {
        const dCell = latLngToCell(d.location.lat, d.location.lng, 8);
        supplyPerCell.set(dCell, (supplyPerCell.get(dCell) ?? 0) + 1);
      }
    }

    // 3. Identify all active cells
    const activeCells = new Set<string>([
      ...demandPerCell.keys(),
      ...supplyPerCell.keys(),
      ...this.surgeMultipliers.keys(),
    ]);

    // 4. For each cell, compute surge step
    for (const cell of activeCells) {
      const demand = demandPerCell.get(cell) ?? 0;
      const supply = supplyPerCell.get(cell) ?? 0;
      const prevState = this.prevSurgeState.get(cell);

      const neighbourCells = gridDisk(cell, 1).filter((c) => c !== cell);
      const neighbourMultipliers = neighbourCells.map(
        (nCell) => this.surgeMultipliers.get(nCell) ?? 1.0,
      );

      const step = computeSurgeStep({
        cell,
        demand,
        supply,
        prevSmoothedDemand: prevState?.smoothedDemand,
        prevSmoothedSupply: prevState?.smoothedSupply,
        prevMultiplier: prevState?.multiplier ?? 1.0,
        neighbourMultipliers,
      });

      this.surgeMultipliers.set(cell, step.finalMultiplier);
      this.prevSurgeState.set(cell, {
        smoothedDemand: step.smoothedDemand,
        smoothedSupply: step.smoothedSupply,
        multiplier: step.finalMultiplier,
      });
    }

    // Schedule next surge cycle
    const nextCycleTime = currentTimeSec + event.payload.intervalSec;
    if (nextCycleTime <= this.scenario.durationSec) {
      this.engine.scheduleAt<SurgeCyclePayload>('SURGE_CYCLE', nextCycleTime, {
        intervalSec: event.payload.intervalSec,
      });
    }
  }

  private handleMatchCycle(event: SimEvent<MatchCyclePayload>): void {
    const currentTimeSec = event.time;

    // 1. Gather all pending rides
    const pendingRides: ActiveRide[] = [];
    for (const ride of this.activeRides.values()) {
      if (!ride.activeOfferId && !ride.assignedDriverId) {
        if (ride.attempts >= this.maxOfferAttempts) {
          this.collector.recordUnmatchedRide({
            rideId: ride.id,
            requestedAtSec: ride.requestedAtSec,
            attempts: ride.attempts,
            reason: 'MAX_ATTEMPTS_EXCEEDED',
          });
          this.activeRides.delete(ride.id);
        } else {
          pendingRides.push(ride);
        }
      }
    }

    if (pendingRides.length > 0) {
      // 2. Gather all IDLE drivers
      const candidates: DriverCandidate[] = [];
      for (const d of this.drivers.values()) {
        if (d.status !== 'IDLE') continue;
        candidates.push({
          id: d.id,
          location: d.location,
          idleSinceMs: d.idleSinceSec * 1000,
        });
      }

      if (candidates.length > 0) {
        const requests: RideRequest[] = pendingRides.map((ride) => ({
          id: ride.id,
          pickup: ride.pickup,
          requestedAtMs: ride.requestedAtSec * 1000,
          excludedDriverIds: Array.from(ride.excludedDrivers),
        }));

        const ctx: MatchContext = {
          nowMs: currentTimeSec * 1000,
          config: {
            speedMps: this.city.baseSpeedMps * this.city.speedMultiplier,
            maxPickupEtaSec: DEFAULT_MATCHING_CONFIG.maxPickupEtaSec,
          },
        };

        const result = this.policy.match(requests, candidates, ctx);

        for (const assignment of result.assignments) {
          const ride = this.activeRides.get(assignment.rideId);
          const driver = this.drivers.get(assignment.driverId);
          if (ride && driver && driver.status === 'IDLE' && !ride.activeOfferId) {
            this.sendOffer(ride, driver, assignment.pickupEtaSec, currentTimeSec);
          }
        }
      }
    }

    // Schedule next match cycle
    const nextCycleTime = currentTimeSec + event.payload.windowSec;
    if (nextCycleTime <= this.scenario.durationSec) {
      this.engine.scheduleAt<MatchCyclePayload>('MATCH_CYCLE', nextCycleTime, {
        windowSec: event.payload.windowSec,
      });
    }
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
    this.sendOffer(ride, driver, assignment.pickupEtaSec, currentTimeSec);
    return true;
  }

  private sendOffer(
    ride: ActiveRide,
    driver: SimDriver,
    pickupEtaSec: number,
    currentTimeSec: number,
  ): void {
    this.nextOfferId += 1;
    const offerId = `off-${this.nextOfferId}`;

    ride.attempts += 1;
    ride.activeOfferId = offerId;
    ride.assignedDriverId = driver.id;
    ride.matchedAtSec = currentTimeSec;
    ride.pickupEtaSec = pickupEtaSec;

    driver.transitionStatus('ON_OFFER', currentTimeSec);
    driver.currentOfferId = offerId;
    driver.currentRideId = ride.id;

    // Driver decision from acceptance model
    const decision = driver.evaluateOffer(pickupEtaSec, this.offerTimeoutSec, this.rng.acceptance);

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

      // In greedy mode: immediate re-offer
      // In batched mode: picked up by next MATCH_CYCLE
      if (!this.isBatched) {
        this.dispatchRide(ride, event.time);
      }
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

    // In greedy mode: immediate re-offer
    // In batched mode: picked up by next MATCH_CYCLE
    if (!this.isBatched) {
      this.dispatchRide(ride, event.time);
    }
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

    if (this.injectAnomalies && this.trustEngine) {
      if (this.rng.driver.nextFloat(0, 1) < 0.05) {
        const anomalyId = `anom-${this.groundTruthAnomalies.length + 1}`;
        this.groundTruthAnomalies.push({
          id: anomalyId,
          type: 'FROZEN_GPS',
          subjectId: driver.id,
          timeSec: event.time,
        });

        const baseMs = event.time * 1000;
        void this.trustEngine.evaluateLocationPing(driver.id, {
          lat: ride.pickup.lat,
          lng: ride.pickup.lng,
          status: 'ON_TRIP',
          timestampMs: baseMs,
        });
        void this.trustEngine.evaluateLocationPing(driver.id, {
          lat: ride.pickup.lat,
          lng: ride.pickup.lng,
          status: 'ON_TRIP',
          timestampMs: baseMs + 320_000,
        });
      } else {
        void this.trustEngine.evaluateLocationPing(driver.id, {
          lat: ride.pickup.lat,
          lng: ride.pickup.lng,
          status: 'ON_TRIP',
          timestampMs: event.time * 1000,
        });
        this.normalEventsCount += 1;
      }
    }

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

    const surgeMultiplier = ride.surgeMultiplier ?? 1.0;
    const { fareCents } = driver.completeTrip(
      ride.pickup,
      ride.dropoff,
      event.time,
      surgeMultiplier,
    );

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

    let biasTarget: LatLng | undefined;
    if (this.isSurgeEnabled) {
      const driverCell = latLngToCell(driver.location.lat, driver.location.lng, 8);
      const currentSurge = this.surgeMultipliers.get(driverCell) ?? 1.0;
      const neighbors = gridDisk(driverCell, 1);

      let maxSurge = currentSurge;
      let targetCell: string | undefined;

      for (const nCell of neighbors) {
        const s = this.surgeMultipliers.get(nCell) ?? 1.0;
        if (s > maxSurge) {
          maxSurge = s;
          targetCell = nCell;
        }
      }

      const repositionBias = this.scenario.surge?.driverRepositionBias ?? 0.5;
      if (
        targetCell &&
        maxSurge > currentSurge &&
        this.rng.driver.nextFloat(0, 1) < repositionBias
      ) {
        const [lat, lng] = cellToLatLng(targetCell);
        biasTarget = { lat, lng };
      }
    }

    driver.roam(this.city, this.rng.driver, event.time, biasTarget);

    if (this.injectAnomalies && this.trustEngine) {
      if (this.rng.driver.nextFloat(0, 1) < 0.04) {
        const isTeleport = this.rng.driver.nextFloat(0, 1) < 0.5;
        const anomalyType = isTeleport ? 'TELEPORT_JUMP' : 'IMPOSSIBLE_SPEED';
        const anomalyId = `anom-${this.groundTruthAnomalies.length + 1}`;
        this.groundTruthAnomalies.push({
          id: anomalyId,
          type: anomalyType,
          subjectId: driver.id,
          timeSec: event.time,
        });

        const offset = isTeleport ? 0.04 : 0.015;
        const badPing = {
          lat: driver.location.lat + offset,
          lng: driver.location.lng + offset,
          status: 'AVAILABLE' as const,
          timestampMs: (event.time + 2) * 1000,
        };
        void this.trustEngine.evaluateLocationPing(driver.id, badPing);
      } else {
        const normalPing = {
          lat: driver.location.lat,
          lng: driver.location.lng,
          status: 'AVAILABLE' as const,
          timestampMs: event.time * 1000,
        };
        void this.trustEngine.evaluateLocationPing(driver.id, normalPing);
        this.normalEventsCount += 1;
      }
    }

    // Periodic roaming check every 60-120 seconds
    const nextRoam = this.rng.driver.nextFloat(60, 120);
    this.engine.schedule<DriverRoamPayload>('DRIVER_ROAM', nextRoam, { driverId });
  }

  run(): SimulationResult {
    this.initializeFleet();
    // Schedule first passenger ride
    this.scheduleNextRide(0);

    // If batched policy, start periodic match cycles
    if (this.isBatched && this.batchWindowSec > 0) {
      this.engine.scheduleAt<MatchCyclePayload>('MATCH_CYCLE', this.batchWindowSec, {
        windowSec: this.batchWindowSec,
      });
    }

    // If surge is enabled, start periodic surge cycles
    if (this.isSurgeEnabled && this.surgeIntervalSec > 0) {
      this.engine.scheduleAt<SurgeCyclePayload>('SURGE_CYCLE', this.surgeIntervalSec, {
        intervalSec: this.surgeIntervalSec,
      });
    }

    // Run discrete event loop
    this.engine.runUntil(this.scenario.durationSec);

    const driversList = Array.from(this.drivers.values());
    const metrics = this.collector.calculate(driversList, this.scenario.durationSec);

    let anomalyReport: AnomalyReport | undefined;
    if (this.injectAnomalies && this.trustEngine) {
      const allFlags = this.trustEngine.getAllFlags();
      const flaggedSubjectIds = new Set(allFlags.map((f) => f.subjectId));
      const injectedSubjectIds = new Set(this.groundTruthAnomalies.map((a) => a.subjectId));

      let truePositives = 0;
      for (const injected of this.groundTruthAnomalies) {
        if (flaggedSubjectIds.has(injected.subjectId)) {
          truePositives += 1;
        }
      }

      let falsePositives = 0;
      for (const flag of allFlags) {
        if (!injectedSubjectIds.has(flag.subjectId)) {
          falsePositives += 1;
        }
      }

      const totalInjected = this.groundTruthAnomalies.length;
      const detectionRate = totalInjected > 0 ? (truePositives / totalInjected) * 100 : 100;
      const falsePositiveRate =
        this.normalEventsCount > 0 ? (falsePositives / this.normalEventsCount) * 100 : 0;

      anomalyReport = {
        totalInjected,
        detectedCount: allFlags.length,
        truePositives,
        falsePositives,
        detectionRate: Number(detectionRate.toFixed(1)),
        falsePositiveRate: Number(falsePositiveRate.toFixed(2)),
        injected: this.groundTruthAnomalies,
      };
    }

    return {
      scenario: this.scenario,
      policy: this.policy,
      seed: this.seed,
      metrics,
      drivers: driversList,
      collector: this.collector,
      anomalies: anomalyReport,
    };
  }
}
