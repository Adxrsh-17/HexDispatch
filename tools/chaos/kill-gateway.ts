import { runContainerKillScenario, type ChaosResult } from './common';

export function runKillGatewayChaos(): Promise<ChaosResult> {
  return runContainerKillScenario({
    scenario: 'kill-gateway',
    target: 'gateway (:3000)',
    notContainerizedReason:
      'apps run as host processes (pnpm dev), not containers; no kill harness exists yet.',
    expectedBehaviour:
      'Clients reconnect with lastEventId and replay missed events from the Redis stream.',
  });
}

if (process.argv[1]?.includes('kill-gateway')) {
  runKillGatewayChaos().then((res) => console.log(JSON.stringify(res, null, 2)));
}
