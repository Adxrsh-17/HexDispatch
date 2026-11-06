import { runContainerKillScenario, type ChaosResult } from './common';

export function runKillRedisChaos(): Promise<ChaosResult> {
  return runContainerKillScenario({
    scenario: 'kill-redis',
    target: 'Redis 7 (driver index, claims, pub/sub)',
    containerName: 'hexdispatch-redis-1',
    healthCommand: 'redis-cli ping',
    healthyOutput: 'PONG',
    expectedBehaviour:
      'Driver claims fail (claims never fall back to a non-atomic path); location index repopulates from pings; trips and payments live in Postgres.',
  });
}

if (process.argv[1]?.includes('kill-redis')) {
  runKillRedisChaos().then((res) => console.log(JSON.stringify(res, null, 2)));
}
