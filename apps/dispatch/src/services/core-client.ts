import { internalFetch } from '@hexdispatch/shared';

/** core-api refused the transition (illegal edge, ride gone, ride already terminal). Not retryable. */
export class RideStateError extends Error {
  constructor(
    readonly rideId: string,
    readonly to: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`core-api rejected ${rideId} -> ${to} (HTTP ${status}): ${detail}`);
    this.name = 'RideStateError';
  }
}

export interface TransitionRequest {
  to: string;
  actor: 'SYSTEM' | 'DRIVER' | 'RIDER' | 'ADMIN';
  driverId?: string | null;
}

/**
 * Ask core-api to move a ride through the trip state machine.
 * Throws RideStateError on a 4xx (the machine said no) and a plain Error on network/5xx failures.
 * Callers must not ignore the result: the state machine in core-api is the source of truth.
 */
export async function requestTransition(
  coreApiUrl: string,
  rideId: string,
  body: TransitionRequest,
): Promise<void> {
  const res = await internalFetch(`${coreApiUrl}/rides/${rideId}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  if (res.status >= 400 && res.status < 500) {
    throw new RideStateError(rideId, body.to, res.status, text.slice(0, 300));
  }
  throw new Error(`core-api transition ${rideId} -> ${body.to} failed with HTTP ${res.status}`);
}
