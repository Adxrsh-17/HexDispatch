import { runContainerKillScenario, type ChaosResult } from './common';

export function runKillKafkaChaos(): Promise<ChaosResult> {
  return runContainerKillScenario({
    scenario: 'kill-kafka',
    target: 'Redpanda (Kafka API, localhost:19092)',
    containerName: 'hexdispatch-redpanda-1',
    healthCommand: 'rpk cluster info',
    healthyOutput: 'redpanda',
    expectedBehaviour:
      'Events stay in the core-api outbox (published_at NULL) and the relay drains them after reconnect; consumers dedupe by eventId.',
  });
}

if (process.argv[1]?.includes('kill-kafka')) {
  runKillKafkaChaos().then((res) => console.log(JSON.stringify(res, null, 2)));
}
