import { pino, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  service: string;
  level?: string;
}

/** JSON logger. Every line carries `service`; Fastify adds `reqId` (the correlation id). */
export function createLogger({ service, level = 'info' }: LoggerOptions): Logger {
  return pino({ name: service, level, base: { service } });
}
