import { DEFAULT_MATCHING_CONFIG, GreedyPolicy } from '@hexdispatch/matching';

// Stub. Phase 4 adds: seeded RNG, scenarios, demand/driver models, metrics, CSV + charts.
// Target command: pnpm sim --scenario peak --policy greedy --seed 42
const policy = new GreedyPolicy();

console.log(`hexdispatch simulator: stub (policy available: ${policy.name}).`);
console.log('Not implemented until Phase 4. See docs/phases/PHASE-4.md.');
console.log(`Matching defaults: ${JSON.stringify(DEFAULT_MATCHING_CONFIG)}`);
console.log(`Args: ${JSON.stringify(process.argv.slice(2))}`);
