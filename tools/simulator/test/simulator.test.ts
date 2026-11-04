import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatchedPolicy, GreedyPolicy } from '@hexdispatch/matching';
import { CitySimulator } from '../src/simulator';
import type { ScenarioConfig } from '../src/scenarios/types';
import { generateCsvReport, type ReportMetadata } from '../src/metrics/report';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadScenario(name: string): ScenarioConfig {
  const filePath = path.resolve(__dirname, `../scenarios/${name}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ScenarioConfig;
}

describe('City Simulator Acceptance Criteria (Phase 4)', () => {
  it('AC3: verifies at least three scenarios exist and are valid JSON configs', () => {
    const normal = loadScenario('normal');
    const peak = loadScenario('peak');
    const rain = loadScenario('rain');

    expect(normal.name).toBe('normal');
    expect(peak.name).toBe('peak');
    expect(rain.name).toBe('rain');

    expect(normal.durationSec).toBeGreaterThan(0);
    expect(peak.durationSec).toBeGreaterThan(0);
    expect(rain.durationSec).toBeGreaterThan(0);

    expect(normal.drivers.count).toBeGreaterThan(0);
    expect(peak.drivers.count).toBeGreaterThan(0);
    expect(rain.drivers.count).toBeGreaterThan(0);
  });

  it('AC5: imports and runs GreedyPolicy directly from @hexdispatch/matching', () => {
    const normal = loadScenario('normal');
    const policy = new GreedyPolicy();

    expect(policy.name).toBe('greedy');
    const sim = new CitySimulator(normal, 42, policy);
    const result = sim.run();

    expect(result.policy.name).toBe('greedy');
    expect(result.metrics.totalRequests).toBeGreaterThan(0);
    expect(result.metrics.completedRides).toBeGreaterThan(0);
  });

  it('AC1: same scenario + policy + seed produce byte-identical metric output', () => {
    const normal = loadScenario('normal');
    const seed = 42;
    const policy1 = new GreedyPolicy();
    const policy2 = new GreedyPolicy();

    const sim1 = new CitySimulator(normal, seed, policy1);
    const result1 = sim1.run();

    const sim2 = new CitySimulator(normal, seed, policy2);
    const result2 = sim2.run();

    // 1. Assert exact metric parity
    expect(result1.metrics).toEqual(result2.metrics);

    // 2. Assert exact byte-identical CSV report output
    const meta: ReportMetadata = {
      scenario: 'normal',
      policy: 'greedy',
      seed: 42,
      commit: 'abc1234',
      command: 'pnpm sim --scenario normal --policy greedy --seed 42',
      durationSec: normal.durationSec,
      timestamp: '2026-11-04T12:00:00.000Z',
    };

    const csv1 = generateCsvReport(meta, result1.metrics, result1.drivers);
    const csv2 = generateCsvReport(meta, result2.metrics, result2.drivers);

    expect(csv1).toBe(csv2);
    expect(Buffer.from(csv1).equals(Buffer.from(csv2))).toBe(true);
  });

  it('AC2: different seeds produce different results', () => {
    const normal = loadScenario('normal');

    const simSeed1 = new CitySimulator(normal, 42, new GreedyPolicy());
    const res1 = simSeed1.run();

    const simSeed2 = new CitySimulator(normal, 9999, new GreedyPolicy());
    const res2 = simSeed2.run();

    // The random arrivals, demand coordinates, and pickup ETAs must differ
    expect(res1.metrics.pickupEtaAvgSec).not.toBe(res2.metrics.pickupEtaAvgSec);
    expect(res1.metrics.totalFareRevenueCents).not.toBe(res2.metrics.totalFareRevenueCents);
  });

  it('runs peak and rain scenarios through simulation without errors', () => {
    const peak = loadScenario('peak');
    const rain = loadScenario('rain');

    const peakSim = new CitySimulator(peak, 42, new GreedyPolicy());
    const peakRes = peakSim.run();
    expect(peakRes.metrics.totalRequests).toBeGreaterThan(1000);
    expect(peakRes.metrics.driverUtilisation).toBeGreaterThan(0.8);

    const rainSim = new CitySimulator(rain, 42, new GreedyPolicy());
    const rainRes = rainSim.run();
    expect(rainRes.metrics.completedRides).toBeGreaterThan(0);
    expect(rainRes.metrics.pickupEtaAvgSec).toBeGreaterThan(0);
  });

  it('runs BatchedPolicy deterministically and yields byte-identical output across duplicate runs', () => {
    const normal = loadScenario('normal');
    normal.durationSec = 1800; // 30 min test
    const seed = 42;

    const sim1 = new CitySimulator(normal, seed, new BatchedPolicy(), 2);
    const res1 = sim1.run();

    const sim2 = new CitySimulator(normal, seed, new BatchedPolicy(), 2);
    const res2 = sim2.run();

    expect(res1.metrics).toEqual(res2.metrics);
    expect(res1.metrics.completedRides).toBeGreaterThan(0);
  });
});
