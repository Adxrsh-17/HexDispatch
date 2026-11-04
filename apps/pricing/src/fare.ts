import { haversineMeters, type LatLng } from '@hexdispatch/matching';

export interface FareRates {
  /** Base fare in integer minor units (e.g. cents / paise). */
  baseFareMinorUnits: number;
  /** Rate per kilometer in minor units. */
  perKmMinorUnits: number;
  /** Rate per minute in minor units. */
  perMinuteMinorUnits: number;
  /** Minimum fare charged in minor units. */
  minimumFareMinorUnits: number;
}

export const DEFAULT_FARE_RATES: Record<string, FareRates> = {
  SEDAN: {
    baseFareMinorUnits: 5000, // 50.00
    perKmMinorUnits: 1500, // 15.00 / km
    perMinuteMinorUnits: 200, // 2.00 / min
    minimumFareMinorUnits: 8000, // 80.00
  },
  SUV: {
    baseFareMinorUnits: 8000, // 80.00
    perKmMinorUnits: 2200, // 22.00 / km
    perMinuteMinorUnits: 300, // 3.00 / min
    minimumFareMinorUnits: 12000, // 120.00
  },
  AUTO: {
    baseFareMinorUnits: 3000, // 30.00
    perKmMinorUnits: 1000, // 10.00 / km
    perMinuteMinorUnits: 150, // 1.50 / min
    minimumFareMinorUnits: 5000, // 50.00
  },
};

export interface FareCalculationInput {
  pickup: LatLng;
  dropoff: LatLng;
  distanceMeters?: number;
  durationSec?: number;
  vehicleType?: string;
  surgeMultiplier?: number;
  speedMps?: number;
  rates?: FareRates;
}

export interface FareBreakdown {
  baseFareMinorUnits: number;
  distanceFareMinorUnits: number;
  durationFareMinorUnits: number;
  subtotalMinorUnits: number;
  surgeMultiplier: number;
  surgedSubtotalMinorUnits: number;
  totalFareMinorUnits: number;
  distanceMeters: number;
  durationSec: number;
}

/**
 * Pure function computing fare with base + per-km + per-minute, surge multiplier,
 * minimum fare threshold, rounded to integer minor units.
 */
export function calculateFare(input: FareCalculationInput): FareBreakdown {
  const vehicleType = (input.vehicleType ?? 'SEDAN').toUpperCase();
  const rates = input.rates ?? DEFAULT_FARE_RATES[vehicleType] ?? DEFAULT_FARE_RATES.SEDAN!;
  const speedMps = input.speedMps ?? 8.33; // ~30 km/h default

  const distanceMeters =
    input.distanceMeters ?? Math.round(haversineMeters(input.pickup, input.dropoff));
  const durationSec = input.durationSec ?? Math.max(60, Math.round(distanceMeters / speedMps));

  const distanceKm = distanceMeters / 1000;
  const durationMinutes = durationSec / 60;

  const baseFare = rates.baseFareMinorUnits;
  const distanceFare = Math.round(distanceKm * rates.perKmMinorUnits);
  const durationFare = Math.round(durationMinutes * rates.perMinuteMinorUnits);
  const subtotal = baseFare + distanceFare + durationFare;

  const surge = Math.max(1.0, Number((input.surgeMultiplier ?? 1.0).toFixed(2)));
  const surgedSubtotal = Math.round(subtotal * surge);
  const totalFare = Math.max(rates.minimumFareMinorUnits, surgedSubtotal);

  return {
    baseFareMinorUnits: baseFare,
    distanceFareMinorUnits: distanceFare,
    durationFareMinorUnits: durationFare,
    subtotalMinorUnits: subtotal,
    surgeMultiplier: surge,
    surgedSubtotalMinorUnits: surgedSubtotal,
    totalFareMinorUnits: totalFare,
    distanceMeters,
    durationSec,
  };
}
