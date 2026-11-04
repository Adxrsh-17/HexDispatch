import { describe, it, expect } from 'vitest';
import { calculateFare, DEFAULT_FARE_RATES } from '../src/fare';

describe('Fare Model (Task 1)', () => {
  const pickup = { lat: 12.9716, lng: 77.5946 };
  // ~5 km north
  const dropoff = { lat: 13.0166, lng: 77.5946 };

  it('calculates standard fare with base + distance + duration in integer minor units', () => {
    const res = calculateFare({
      pickup,
      dropoff,
      distanceMeters: 5000,
      durationSec: 600, // 10 minutes
      vehicleType: 'SEDAN',
      surgeMultiplier: 1.0,
    });

    // Sedan rates:
    // Base: 5000 (INR 50.00)
    // Distance: 5 km * 1500 = 7500 (INR 75.00)
    // Duration: 10 min * 200 = 2000 (INR 20.00)
    // Subtotal: 14500 (INR 145.00)
    expect(res.baseFareMinorUnits).toBe(5000);
    expect(res.distanceFareMinorUnits).toBe(7500);
    expect(res.durationFareMinorUnits).toBe(2000);
    expect(res.subtotalMinorUnits).toBe(14500);
    expect(res.surgeMultiplier).toBe(1.0);
    expect(res.totalFareMinorUnits).toBe(14500);
  });

  it('enforces minimum fare threshold when distance and duration are minimal', () => {
    const res = calculateFare({
      pickup,
      dropoff: { lat: 12.9717, lng: 77.5946 }, // ~10 meters away
      distanceMeters: 10,
      durationSec: 60,
      vehicleType: 'SEDAN',
      surgeMultiplier: 1.0,
    });

    // Subtotal would be: 5000 + 15 + 200 = 5215 < 8000 min fare
    expect(res.subtotalMinorUnits).toBe(5215);
    expect(res.totalFareMinorUnits).toBe(DEFAULT_FARE_RATES.SEDAN!.minimumFareMinorUnits);
    expect(res.totalFareMinorUnits).toBe(8000);
  });

  it('applies surge multiplier correctly to the subtotal before min fare check', () => {
    const res = calculateFare({
      pickup,
      dropoff,
      distanceMeters: 5000,
      durationSec: 600,
      vehicleType: 'SEDAN',
      surgeMultiplier: 1.5,
    });

    // Subtotal: 14500 * 1.5 = 21750
    expect(res.subtotalMinorUnits).toBe(14500);
    expect(res.surgeMultiplier).toBe(1.5);
    expect(res.surgedSubtotalMinorUnits).toBe(21750);
    expect(res.totalFareMinorUnits).toBe(21750);
  });

  it('handles SUV and AUTO vehicle types with their respective rate tables', () => {
    const resAuto = calculateFare({
      pickup,
      dropoff,
      distanceMeters: 5000,
      durationSec: 600,
      vehicleType: 'AUTO',
      surgeMultiplier: 1.0,
    });
    // Auto: base 3000 + 5*1000 (5000) + 10*150 (1500) = 9500
    expect(resAuto.totalFareMinorUnits).toBe(9500);

    const resSuv = calculateFare({
      pickup,
      dropoff,
      distanceMeters: 5000,
      durationSec: 600,
      vehicleType: 'SUV',
      surgeMultiplier: 1.0,
    });
    // SUV: base 8000 + 5*2200 (11000) + 10*300 (3000) = 22000
    expect(resSuv.totalFareMinorUnits).toBe(22000);
  });
});

