import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BatchedPolicy, GreedyPolicy, type MatchingPolicy } from '@hexdispatch/matching';
import { CitySimulator } from './simulator';
import type { ScenarioConfig } from './scenarios/types';
import {
  generateCsvReport,
  generateEtaDistributionSvg,
  generateMarkdownSummary,
  type ReportMetadata,
} from './metrics/report';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

interface ParsedArgs {
  scenario: string;
  policy: string;
  seed: number;
  duration?: number;
  window: number;
  surge?: boolean;
  outDir: string;
  writeFiles: boolean;
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv.filter((a) => a !== '--');
  let scenario = 'normal';
  let policy = 'greedy';
  let seed = 42;
  let duration: number | undefined;
  let window = 2;
  let surge: boolean | undefined;
  let outDir = path.resolve(__dirname, '../../../docs/benchmarks');
  let writeFiles = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--scenario' && args[i + 1]) {
      scenario = args[++i]!;
    } else if (arg === '--policy' && args[i + 1]) {
      policy = args[++i]!;
    } else if (arg === '--seed' && args[i + 1]) {
      seed = Number.parseInt(args[++i]!, 10);
    } else if (arg === '--duration' && args[i + 1]) {
      duration = Number.parseInt(args[++i]!, 10);
    } else if (arg === '--window' && args[i + 1]) {
      window = Number.parseFloat(args[++i]!);
    } else if (arg === '--surge') {
      surge = true;
    } else if (arg === '--no-surge') {
      surge = false;
    } else if (arg === '--out' && args[i + 1]) {
      outDir = path.resolve(process.cwd(), args[++i]!);
    } else if (arg === '--no-write') {
      writeFiles = false;
    }
  }

  return { scenario, policy, seed, duration, window, surge, outDir, writeFiles };
}

function loadScenario(name: string): ScenarioConfig {
  const scenarioPath = path.resolve(__dirname, `../scenarios/${name}.json`);
  if (!fs.existsSync(scenarioPath)) {
    throw new Error(
      `Scenario file '${name}.json' not found at ${scenarioPath}. Available: normal, peak, rain.`,
    );
  }
  const raw = fs.readFileSync(scenarioPath, 'utf-8');
  return JSON.parse(raw) as ScenarioConfig;
}

function resolvePolicy(name: string): MatchingPolicy {
  const lower = name.toLowerCase();
  if (lower === 'greedy') {
    return new GreedyPolicy();
  }
  if (lower === 'batched') {
    return new BatchedPolicy();
  }
  throw new Error(`Unsupported policy '${name}'. Supported policies: 'greedy', 'batched'.`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  const scenario = loadScenario(parsed.scenario);
  if (parsed.duration) {
    scenario.durationSec = parsed.duration;
  }

  const policy = resolvePolicy(parsed.policy);
  const gitCommit = getGitCommit();
  const command = `pnpm sim --scenario ${parsed.scenario} --policy ${parsed.policy} --seed ${parsed.seed}${parsed.window !== 2 ? ` --window ${parsed.window}` : ''}`;
  const timestamp = new Date().toISOString();

  console.log('====================================================');
  console.log(`HexDispatch Simulator: ${scenario.name.toUpperCase()} Scenario`);
  console.log(`Policy: ${policy.name} | Seed: ${parsed.seed} | Duration: ${scenario.durationSec}s`);
  console.log('====================================================');

  const sim = new CitySimulator(scenario, parsed.seed, policy, parsed.window, parsed.surge);
  const startMs = Date.now();
  const result = sim.run();
  const elapsedMs = Date.now() - startMs;

  const { metrics } = result;

  console.log('\n--- Simulation Summary ---');
  console.log(`Requests:          ${metrics.totalRequests}`);
  console.log(
    `Completed:         ${metrics.completedRides} (${(metrics.matchRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `Unmatched:         ${metrics.unmatchedRides} (${(metrics.noDriverRate * 100).toFixed(1)}%)`,
  );
  if (metrics.surgeAbandonedRides !== undefined && metrics.surgeAbandonedRides > 0) {
    console.log(
      `Surge Abandoned:   ${metrics.surgeAbandonedRides} (${((metrics.surgeAbandonedRides / metrics.totalRequests) * 100).toFixed(1)}%)`,
    );
  }
  console.log(
    `Pickup ETA Avg:    ${Math.round(metrics.pickupEtaAvgSec)}s (~${(metrics.pickupEtaAvgSec / 60).toFixed(1)} min)`,
  );
  console.log(
    `Pickup ETA p95:    ${Math.round(metrics.pickupEtaP95Sec)}s (~${(metrics.pickupEtaP95Sec / 60).toFixed(1)} min)`,
  );
  console.log(`Pickup ETA Median: ${Math.round(metrics.pickupEtaMedianSec)}s`);
  console.log(`Driver Util:       ${(metrics.driverUtilisation * 100).toFixed(1)}%`);
  console.log(`Avg Idle Time:     ${Math.round(metrics.idleTimeAvgSec)}s`);
  console.log(`Rides/Driver-Hr:   ${metrics.ridesPerDriverHour}`);
  console.log(`Total Revenue:     $${(metrics.totalFareRevenueCents / 100).toFixed(2)}`);
  console.log(`Avg Driver Earn:   $${(metrics.avgDriverEarningsCents / 100).toFixed(2)}`);
  console.log(`Earnings Gini:     ${metrics.giniCoefficient}`);
  console.log(`p90/p10 Spread:    ${metrics.p90p10EarningsRatio}x`);
  console.log(`Execution Time:    ${elapsedMs}ms`);

  if (parsed.writeFiles) {
    fs.mkdirSync(parsed.outDir, { recursive: true });

    const metadata: ReportMetadata = {
      scenario: parsed.scenario,
      policy: parsed.policy,
      seed: parsed.seed,
      commit: gitCommit,
      command,
      durationSec: scenario.durationSec,
      timestamp,
    };

    const baseName = `${parsed.scenario}-${parsed.policy}-seed${parsed.seed}`;
    const csvPath = path.join(parsed.outDir, `${baseName}.csv`);
    const mdPath = path.join(parsed.outDir, `${baseName}.md`);
    const svgPath = path.join(parsed.outDir, `${baseName}-eta.svg`);

    fs.writeFileSync(csvPath, generateCsvReport(metadata, metrics, result.drivers));
    fs.writeFileSync(mdPath, generateMarkdownSummary(metadata, metrics));
    fs.writeFileSync(svgPath, generateEtaDistributionSvg(result.collector.getCompletedRides()));

    console.log(`\nOutputs written to ${parsed.outDir}:`);
    console.log(`  - CSV:  ${baseName}.csv`);
    console.log(`  - MD:   ${baseName}.md`);
    console.log(`  - SVG:  ${baseName}-eta.svg`);
  }
}

// Direct execution
if (process.argv[1]?.includes('simulator')) {
  main().catch((err) => {
    console.error('Simulation error:', err);
    process.exit(1);
  });
}
