import { runContainerKillScenario, type ChaosResult } from './common';

export function runKillDispatchChaos(): Promise<ChaosResult> {
  return runContainerKillScenario({
    scenario: 'kill-dispatch',
    target: 'dispatch service (:3003)',
    notContainerizedReason:
      'apps run as host processes (pnpm dev), not containers; no kill harness exists yet. Restart behaviour is covered by apps/dispatch/test/recovery.test.ts and hardening.test.ts instead.',
    expectedBehaviour:
      'Pending offers re-arm from Postgres; MATCHING rides are re-read from core-api on boot.',
  });
}

if (process.argv[1]?.includes('kill-dispatch')) {
  runKillDispatchChaos().then((res) => console.log(JSON.stringify(res, null, 2)));
}
