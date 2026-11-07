import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatchedPolicy, GreedyPolicy } from '@hexdispatch/matching';
import { CitySimulator } from '../src/simulator';
import type { ScenarioConfig } from '../src/scenarios/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadScenario(name: string): ScenarioConfig {
  const filePath = path.resolve(__dirname, `../scenarios/${name}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as ScenarioConfig;
}

describe('Simulator Conservation & Non-Overlapping Invariants', () => {
  const scenarios = ['normal', 'peak', 'rain'];
  const policies = [
    { name: 'greedy', factory: () => new GreedyPolicy() },
    { name: 'batched', factory: () => new BatchedPolicy() },
  ];
  const testSeeds = [42, 100];

  for (const scenarioName of scenarios) {
    for (const { name: policyName, factory } of policies) {
      it(`conserves requests and has zero driver overlaps for ${scenarioName} with ${policyName}`, () => {
        for (const seed of testSeeds) {
          const scenario = loadScenario(scenarioName);
          const sim = new CitySimulator(scenario, seed, factory(), 2);
          const result = sim.run();

          const { metrics } = result;

          // 1. Exact Request Conservation Law:
          // totalRequests = completed + abandoned + no-driver + still-waiting-at-end
          const sumOfCohorts =
            metrics.completedRides +
            metrics.abandonedRides +
            metrics.noDriverRides +
            metrics.stillWaitingAtEnd;

          expect(metrics.totalRequests).toBeGreaterThan(0);
          expect(metrics.totalRequests).toBe(sumOfCohorts);

          // 2. No Driver Overlapping Assignments Invariant:
          expect(result.noDriverOverlap).toBe(true);
          expect(sim.verifyNoDriverOverlap()).toBe(true);

          // Deep check across all driver intervals
          const driverAssignments = sim.getDriverAssignments();
          for (const [driverId, intervals] of driverAssignments.entries()) {
            const sorted = [...intervals].sort((a, b) => a.startSec - b.startSec);
            for (let i = 1; i < sorted.length; i++) {
              const prev = sorted[i - 1]!;
              const curr = sorted[i]!;
              const prevEnd = prev.endSec ?? scenario.durationSec;
              expect(
                curr.startSec,
                `Driver ${driverId} overlapping rides ${prev.rideId} and ${curr.rideId}`,
              ).toBeGreaterThanOrEqual(prevEnd);
            }
          }
        }
      });
    }
  }
});
