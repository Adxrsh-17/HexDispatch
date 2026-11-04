import type { CityConfig } from '../models/city';
import type { DemandConfig } from '../models/demand';

export interface DriverFleetConfig {
  count: number;
  baseAcceptanceRate?: number;
  minShiftDurationSec?: number;
  maxShiftDurationSec?: number;
}

export interface MatchingSettings {
  policy: string; // 'greedy' | 'batch' | etc.
  batchWindowSec?: number;
  maxOfferAttempts?: number;
  offerTimeoutSec?: number;
}

export interface SurgeSimulatorConfig {
  enabled: boolean;
  updateIntervalSec?: number;
  priceElasticity?: number;
  driverRepositionBias?: number;
}

export interface ScenarioConfig {
  name: string;
  description: string;
  durationSec: number;
  city: CityConfig;
  demand: DemandConfig;
  drivers: DriverFleetConfig;
  matching?: Partial<MatchingSettings>;
  surge?: Partial<SurgeSimulatorConfig>;
}
