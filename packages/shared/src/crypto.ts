import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Compute deterministic SHA-256 hex hash of any JSON-serializable payload. */
export function hashPayload(payload: unknown): string {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  return createHash('sha256').update(serialized).digest('hex');
}
