import { describe, it, expect } from 'vitest';
import { MockPspClient } from '../src/psp/mock-psp';

describe('Mock PSP Client (Task 1 & 3)', () => {
  it('honours idempotency: duplicate authorizations return identical response', async () => {
    const psp = new MockPspClient();
    const idempotencyKey = 'auth_idemp_key_1';

    const res1 = await psp.authorize({
      idempotencyKey,
      rideId: 'ride-1',
      amountMinorUnits: 5000,
    });
    expect(res1.status).toBe('AUTHORIZED');

    const res2 = await psp.authorize({
      idempotencyKey,
      rideId: 'ride-1',
      amountMinorUnits: 5000,
    });
    expect(res2.status).toBe('AUTHORIZED');
    expect(res2.pspRef).toBe(res1.pspRef);

    const records = psp.getAllRecords();
    expect(records).toHaveLength(1);
  });

  it('honours idempotency on capture', async () => {
    const psp = new MockPspClient();
    const auth = await psp.authorize({
      idempotencyKey: 'auth_key_2',
      rideId: 'ride-2',
      amountMinorUnits: 7500,
    });

    const capKey = 'capture_key_2';
    const cap1 = await psp.capture({
      idempotencyKey: capKey,
      pspRef: auth.pspRef,
      amountMinorUnits: 7500,
    });
    expect(cap1.status).toBe('CAPTURED');

    const cap2 = await psp.capture({
      idempotencyKey: capKey,
      pspRef: auth.pspRef,
      amountMinorUnits: 7500,
    });
    expect(cap2.status).toBe('CAPTURED');
    expect(cap2.pspRef).toBe(cap1.pspRef);
  });

  it('allows querying transactions by idempotency key to resolve timeouts', async () => {
    const psp = new MockPspClient({ timeoutRate: 1.0 }); // always timeouts
    const idempotencyKey = 'auth_timeout_key';

    // The call throws timeout error
    await expect(
      psp.authorize({
        idempotencyKey,
        rideId: 'ride-timeout',
        amountMinorUnits: 3000,
      }),
    ).rejects.toThrow(/timeout/i);

    // Caller queries PSP with the same key
    const record = await psp.queryByIdempotencyKey(idempotencyKey);
    expect(record).not.toBeNull();
    expect(record?.status).toBe('SUCCESS');
    expect(record?.amountMinorUnits).toBe(3000);
  });
});
