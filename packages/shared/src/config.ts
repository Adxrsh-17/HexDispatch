import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Env vars every service understands. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  HOST: z.string().min(1).default('0.0.0.0'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Validate an env source against a zod schema. Throws one readable error that lists
 * every bad variable, so a misconfigured service fails at boot, not at first use.
 */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data as z.infer<S>;
}

export interface ServiceEnv extends BaseEnv {
  PORT: number;
}

/**
 * Base env plus the service port, read from a per-service variable (e.g. GATEWAY_PORT)
 * so all services can share one .env file.
 */
export function loadServiceEnv(
  portVar: string,
  defaultPort: number,
  source: Record<string, string | undefined> = process.env,
): ServiceEnv {
  const base = loadEnv(baseEnvSchema, source);
  const portSchema = z.object({
    [portVar]: z.coerce.number().int().min(1).max(65535).default(defaultPort),
  });
  const parsed = loadEnv(portSchema, source) as Record<string, number>;
  return { ...base, PORT: parsed[portVar] ?? defaultPort };
}
