import { execSync } from 'node:child_process';

/**
 * Honest chaos results.
 *
 * What is measured: how long a dependency container takes to answer its health probe again after
 * `docker stop` + `docker start`. That is infrastructure recovery time, nothing more.
 * What is NOT measured here: application behaviour during the outage, or data loss. Those need
 * assertions against running services (see docs/resilience.md "What is not measured").
 * If Docker is not available the scenario is reported as NOT_RUN. It never fabricates a number.
 */
export interface ChaosResult {
  scenario: string;
  target: string;
  status: 'MEASURED' | 'NOT_RUN';
  /** Why the scenario did not run. */
  reason?: string;
  /** Design intent. Not observed by this script. */
  expectedBehaviour: string;
  /** Milliseconds from `docker stop` until the health probe passes again. null when NOT_RUN. */
  containerRecoveryMs: number | null;
}

export function runDockerCommand(cmd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, output };
  } catch (err: unknown) {
    return { success: false, output: err instanceof Error ? err.message : String(err) };
  }
}

export function isDockerAvailable(): boolean {
  return runDockerCommand('docker info').success;
}

export interface ContainerKillScenario {
  scenario: string;
  target: string;
  /** Docker container name, or undefined when the component does not run in a container. */
  containerName?: string;
  /** Command run inside the container; must succeed and print `healthyOutput` when healthy. */
  healthCommand?: string;
  healthyOutput?: string;
  dwellMs?: number;
  timeoutMs?: number;
  expectedBehaviour: string;
  notContainerizedReason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runContainerKillScenario(s: ContainerKillScenario): Promise<ChaosResult> {
  const base = { scenario: s.scenario, target: s.target, expectedBehaviour: s.expectedBehaviour };

  if (!s.containerName || !s.healthCommand) {
    return {
      ...base,
      status: 'NOT_RUN',
      reason: s.notContainerizedReason ?? 'no container harness for this component',
      containerRecoveryMs: null,
    };
  }
  if (!isDockerAvailable()) {
    return {
      ...base,
      status: 'NOT_RUN',
      reason: 'Docker is not available on this machine',
      containerRecoveryMs: null,
    };
  }

  const startMs = Date.now();
  const stopped = runDockerCommand(`docker stop ${s.containerName}`);
  if (!stopped.success) {
    return {
      ...base,
      status: 'NOT_RUN',
      reason: `could not stop ${s.containerName}: ${stopped.output.slice(0, 120)}`,
      containerRecoveryMs: null,
    };
  }
  await sleep(s.dwellMs ?? 1000);
  runDockerCommand(`docker start ${s.containerName}`);

  const timeoutMs = s.timeoutMs ?? 30_000;
  while (Date.now() - startMs < timeoutMs) {
    const probe = runDockerCommand(`docker exec ${s.containerName} ${s.healthCommand}`);
    if (probe.success && probe.output.includes(s.healthyOutput ?? '')) {
      return { ...base, status: 'MEASURED', containerRecoveryMs: Date.now() - startMs };
    }
    await sleep(250);
  }
  return {
    ...base,
    status: 'NOT_RUN',
    reason: `${s.containerName} did not become healthy within ${timeoutMs} ms`,
    containerRecoveryMs: null,
  };
}
