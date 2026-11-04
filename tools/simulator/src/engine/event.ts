import type { TimedEvent } from './priority-queue';
import type { LatLng } from '@hexdispatch/matching';

export type EventType =
  | 'DRIVER_ONLINE'
  | 'DRIVER_OFFLINE'
  | 'RIDE_REQUESTED'
  | 'MATCH_CYCLE'
  | 'RETRY_MATCH'
  | 'OFFER_EVALUATE'
  | 'OFFER_TIMEOUT'
  | 'DRIVER_ARRIVE_PICKUP'
  | 'TRIP_START'
  | 'TRIP_COMPLETE'
  | 'DRIVER_ROAM';

export interface SimEvent<TPayload = unknown> extends TimedEvent {
  id: string;
  type: EventType;
  time: number; // Simulation time in seconds
  seq: number; // Monotonic sequence number for deterministic tie-breaking
  payload: TPayload;
}

export interface DriverOnlinePayload {
  driverId: string;
  location: LatLng;
}

export interface DriverOfflinePayload {
  driverId: string;
}

export interface RideRequestedPayload {
  rideId: string;
  pickup: LatLng;
  dropoff: LatLng;
}

export interface RetryMatchPayload {
  rideId: string;
}

export interface OfferEvaluatePayload {
  offerId: string;
  rideId: string;
  driverId: string;
  accepted: boolean;
}

export interface OfferTimeoutPayload {
  offerId: string;
  rideId: string;
  driverId: string;
}

export interface DriverArrivePickupPayload {
  rideId: string;
  driverId: string;
}

export interface TripStartPayload {
  rideId: string;
  driverId: string;
}

export interface TripCompletePayload {
  rideId: string;
  driverId: string;
  fare: number;
}

export interface DriverRoamPayload {
  driverId: string;
}
