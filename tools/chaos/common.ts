import { execSync } from 'node:child_process';

export interface ChaosResult {
  scenario: string;
  target: string;
  expectedDegraded: string;
  observedDegraded: string;
  dataLoss: boolean;
  dataLossDetails: string;
  recoveryTimeMs: number;
}

export function runDockerCommand(cmd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, output };
  } catch (err: unknown) {
    return { success: false, output: err instanceof Error ? err.message : String(err) };
  }
}
