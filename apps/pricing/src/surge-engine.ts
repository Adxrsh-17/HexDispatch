export interface SurgeConfig {
  /** Alpha for EWMA smoothing (0..1). Default 0.3. */
  alpha: number;
  /** Multiplier slope k. Default 0.5. */
  k: number;
  /** Minimum denominator for supply to prevent div-by-zero. Default 1.0. */
  epsilon: number;
  /** Maximum allowable surge multiplier. Default 2.5. */
  maxSurge: number;
  /** Maximum allowable step change between intervals. Default 0.2. */
  maxStep: number;
  /** Upward dead-band threshold for hysteresis. Default 0.05. */
  upThreshold: number;
  /** Downward dead-band threshold for hysteresis (must be < upThreshold). Default 0.03. */
  downThreshold: number;
  /** Weight for neighbour ring-1 mean blending (0..1). Default 0.2. */
  beta: number;
}

export const DEFAULT_SURGE_CONFIG: SurgeConfig = {
  alpha: 0.3,
  k: 0.5,
  epsilon: 1.0,
  maxSurge: 2.5,
  maxStep: 0.2,
  upThreshold: 0.05,
  downThreshold: 0.03,
  beta: 0.2,
};

export interface SurgeStepInputs {
  cell: string;
  demand: number;
  supply: number;
  prevSmoothedDemand?: number;
  prevSmoothedSupply?: number;
  prevMultiplier?: number;
  neighbourMultipliers?: number[];
  adminOverride?: number;
  config?: Partial<SurgeConfig>;
}

export interface SurgeExplainOutput {
  cell: string;
  demand: number;
  supply: number;
  smoothedDemand: number;
  smoothedSupply: number;
  ratio: number;
  rawMultiplier: number;
  steppedMultiplier: number;
  hysteresisMultiplier: number;
  neighbourMean: number;
  finalMultiplier: number;
  hasAdminOverride: boolean;
  adminOverride?: number;
}

/**
 * Pure function computing cell surge multiplier following Section 6 of PROJECT_PLAN.
 * Includes EWMA, raw ratio clamp, step limiting, hysteresis dead-band, and neighbour blending.
 */
export function computeSurgeStep(inputs: SurgeStepInputs): SurgeExplainOutput {
  const cfg: SurgeConfig = { ...DEFAULT_SURGE_CONFIG, ...inputs.config };

  // 1. EWMA smoothing
  const smoothedDemand =
    inputs.prevSmoothedDemand !== undefined
      ? cfg.alpha * inputs.demand + (1 - cfg.alpha) * inputs.prevSmoothedDemand
      : inputs.demand;

  const smoothedSupply =
    inputs.prevSmoothedSupply !== undefined
      ? cfg.alpha * inputs.supply + (1 - cfg.alpha) * inputs.prevSmoothedSupply
      : inputs.supply;

  // 2. Raw multiplier calculation and clamping
  const effectiveSupply = Math.max(smoothedSupply, cfg.epsilon);
  const ratio = smoothedDemand / effectiveSupply;
  const rawCalculated = 1 + cfg.k * Math.max(0, ratio - 1);
  const rawMultiplier = Math.min(cfg.maxSurge, Math.max(1.0, rawCalculated));

  // 3. Step limiting
  const prevM = inputs.prevMultiplier ?? 1.0;
  const stepDiff = rawMultiplier - prevM;
  let steppedMultiplier = rawMultiplier;
  if (Math.abs(stepDiff) > cfg.maxStep) {
    steppedMultiplier = prevM + Math.sign(stepDiff) * cfg.maxStep;
  }
  steppedMultiplier = Math.min(cfg.maxSurge, Math.max(1.0, steppedMultiplier));

  // 4. Hysteresis (dead-band)
  let hysteresisMultiplier = prevM;
  if (steppedMultiplier > prevM + cfg.upThreshold) {
    hysteresisMultiplier = steppedMultiplier;
  } else if (steppedMultiplier < prevM - cfg.downThreshold) {
    hysteresisMultiplier = steppedMultiplier;
  } else {
    hysteresisMultiplier = prevM;
  }

  // 5. Neighbour ring-1 blending
  const neighbours = inputs.neighbourMultipliers ?? [];
  let neighbourMean = hysteresisMultiplier;
  if (neighbours.length > 0) {
    const sum = neighbours.reduce((acc, v) => acc + v, 0);
    neighbourMean = sum / neighbours.length;
  }

  const blended = (1 - cfg.beta) * hysteresisMultiplier + cfg.beta * neighbourMean;
  let finalMultiplier = Number(blended.toFixed(2));
  finalMultiplier = Math.min(cfg.maxSurge, Math.max(1.0, finalMultiplier));

  // 6. Admin Override check
  const hasAdminOverride = inputs.adminOverride !== undefined && inputs.adminOverride >= 1.0;
  if (hasAdminOverride) {
    finalMultiplier = Number(inputs.adminOverride!.toFixed(2));
  }

  return {
    cell: inputs.cell,
    demand: inputs.demand,
    supply: inputs.supply,
    smoothedDemand: Number(smoothedDemand.toFixed(2)),
    smoothedSupply: Number(smoothedSupply.toFixed(2)),
    ratio: Number(ratio.toFixed(2)),
    rawMultiplier: Number(rawMultiplier.toFixed(2)),
    steppedMultiplier: Number(steppedMultiplier.toFixed(2)),
    hysteresisMultiplier: Number(hysteresisMultiplier.toFixed(2)),
    neighbourMean: Number(neighbourMean.toFixed(2)),
    finalMultiplier,
    hasAdminOverride,
    adminOverride: hasAdminOverride ? inputs.adminOverride : undefined,
  };
}

