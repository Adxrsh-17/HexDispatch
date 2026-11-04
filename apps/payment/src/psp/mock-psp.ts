import { randomUUID } from 'node:crypto';

export interface MockPspConfig {
  seed?: number;
  failureRate?: number; // 0..1
  timeoutRate?: number; // 0..1
  latencyMs?: number;
}

export interface PspTransactionRecord {
  pspRef: string;
  idempotencyKey: string;
  rideId: string;
  kind: 'AUTHORIZE' | 'CAPTURE' | 'REFUND' | 'RELEASE';
  amountMinorUnits: number;
  status: 'SUCCESS' | 'FAILED';
  createdAt: Date;
}

export interface PspAuthResponse {
  pspRef: string;
  idempotencyKey: string;
  status: 'AUTHORIZED' | 'FAILED';
  amountMinorUnits: number;
}

export interface PspCaptureResponse {
  pspRef: string;
  idempotencyKey: string;
  status: 'CAPTURED' | 'FAILED';
  amountMinorUnits: number;
}

export interface PspRefundResponse {
  pspRef: string;
  refundRef: string;
  idempotencyKey: string;
  status: 'REFUNDED' | 'FAILED';
  amountMinorUnits: number;
}

export interface PspReleaseResponse {
  pspRef: string;
  idempotencyKey: string;
  status: 'RELEASED' | 'FAILED';
}

/**
 * Lightweight deterministic LCG generator (PCG/Mulberry32) for zero external dependencies.
 */
class DeterministicRng {
  private s: number;
  constructor(seed = 42) {
    this.s = seed >>> 0;
  }
  nextFloat(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export class MockPspClient {
  private rng: DeterministicRng;
  private idempotencyStore = new Map<string, unknown>();
  private transactions = new Map<string, PspTransactionRecord>(); // key: pspRef
  private keyToPspRef = new Map<string, string>(); // idempotencyKey -> pspRef

  constructor(private config: MockPspConfig = {}) {
    this.rng = new DeterministicRng(config.seed ?? 42);
  }

  reset(): void {
    this.idempotencyStore.clear();
    this.transactions.clear();
    this.keyToPspRef.clear();
    this.rng = new DeterministicRng(this.config.seed ?? 42);
  }

  private async simulateNetwork(): Promise<void> {
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }
  }

  async authorize(params: {
    idempotencyKey: string;
    rideId: string;
    amountMinorUnits: number;
  }): Promise<PspAuthResponse> {
    await this.simulateNetwork();

    // 1. Check idempotency
    const cached = this.idempotencyStore.get(params.idempotencyKey) as PspAuthResponse | undefined;
    if (cached) {
      return cached;
    }

    // 2. Check timeout simulation
    if (this.config.timeoutRate && this.rng.nextFloat() < this.config.timeoutRate) {
      // Simulate PSP executing successfully on their side, but caller timed out before response
      const pspRef = `psp_auth_${randomUUID().slice(0, 8)}`;
      const record: PspTransactionRecord = {
        pspRef,
        idempotencyKey: params.idempotencyKey,
        rideId: params.rideId,
        kind: 'AUTHORIZE',
        amountMinorUnits: params.amountMinorUnits,
        status: 'SUCCESS',
        createdAt: new Date(),
      };
      this.transactions.set(pspRef, record);
      this.keyToPspRef.set(params.idempotencyKey, pspRef);
      const res: PspAuthResponse = {
        pspRef,
        idempotencyKey: params.idempotencyKey,
        status: 'AUTHORIZED',
        amountMinorUnits: params.amountMinorUnits,
      };
      this.idempotencyStore.set(params.idempotencyKey, res);

      const err = new Error('PSP Gateway Timeout (ETIMEDOUT)') as Error & { code?: string };
      err.code = 'ETIMEDOUT';
      throw err;
    }

    // 3. Check failure simulation
    if (this.config.failureRate && this.rng.nextFloat() < this.config.failureRate) {
      const pspRef = `psp_auth_failed_${randomUUID().slice(0, 8)}`;
      const res: PspAuthResponse = {
        pspRef,
        idempotencyKey: params.idempotencyKey,
        status: 'FAILED',
        amountMinorUnits: params.amountMinorUnits,
      };
      this.idempotencyStore.set(params.idempotencyKey, res);
      return res;
    }

    // 4. Success authorization
    const pspRef = `psp_auth_${randomUUID().slice(0, 8)}`;
    const record: PspTransactionRecord = {
      pspRef,
      idempotencyKey: params.idempotencyKey,
      rideId: params.rideId,
      kind: 'AUTHORIZE',
      amountMinorUnits: params.amountMinorUnits,
      status: 'SUCCESS',
      createdAt: new Date(),
    };
    this.transactions.set(pspRef, record);
    this.keyToPspRef.set(params.idempotencyKey, pspRef);

    const res: PspAuthResponse = {
      pspRef,
      idempotencyKey: params.idempotencyKey,
      status: 'AUTHORIZED',
      amountMinorUnits: params.amountMinorUnits,
    };
    this.idempotencyStore.set(params.idempotencyKey, res);
    return res;
  }

  async capture(params: {
    idempotencyKey: string;
    pspRef: string;
    amountMinorUnits: number;
  }): Promise<PspCaptureResponse> {
    await this.simulateNetwork();

    // 1. Check idempotency
    const cached = this.idempotencyStore.get(params.idempotencyKey) as
      PspCaptureResponse | undefined;
    if (cached) {
      return cached;
    }

    // 2. Validate original authorization
    const authRecord = this.transactions.get(params.pspRef);
    if (!authRecord) {
      throw new Error(`Original authorization not found for ref ${params.pspRef}`);
    }

    // 3. Check timeout simulation
    if (this.config.timeoutRate && this.rng.nextFloat() < this.config.timeoutRate) {
      const record: PspTransactionRecord = {
        pspRef: params.pspRef,
        idempotencyKey: params.idempotencyKey,
        rideId: authRecord.rideId,
        kind: 'CAPTURE',
        amountMinorUnits: params.amountMinorUnits,
        status: 'SUCCESS',
        createdAt: new Date(),
      };
      this.transactions.set(`cap_${params.pspRef}`, record);
      this.keyToPspRef.set(params.idempotencyKey, params.pspRef);
      const res: PspCaptureResponse = {
        pspRef: params.pspRef,
        idempotencyKey: params.idempotencyKey,
        status: 'CAPTURED',
        amountMinorUnits: params.amountMinorUnits,
      };
      this.idempotencyStore.set(params.idempotencyKey, res);

      const err = new Error('PSP Gateway Timeout on capture (ETIMEDOUT)') as Error & {
        code?: string;
      };
      err.code = 'ETIMEDOUT';
      throw err;
    }

    // 4. Check failure simulation
    if (this.config.failureRate && this.rng.nextFloat() < this.config.failureRate) {
      const res: PspCaptureResponse = {
        pspRef: params.pspRef,
        idempotencyKey: params.idempotencyKey,
        status: 'FAILED',
        amountMinorUnits: params.amountMinorUnits,
      };
      this.idempotencyStore.set(params.idempotencyKey, res);
      return res;
    }

    // 5. Success capture
    const record: PspTransactionRecord = {
      pspRef: params.pspRef,
      idempotencyKey: params.idempotencyKey,
      rideId: authRecord.rideId,
      kind: 'CAPTURE',
      amountMinorUnits: params.amountMinorUnits,
      status: 'SUCCESS',
      createdAt: new Date(),
    };
    this.transactions.set(`cap_${params.pspRef}`, record);
    this.keyToPspRef.set(params.idempotencyKey, params.pspRef);

    const res: PspCaptureResponse = {
      pspRef: params.pspRef,
      idempotencyKey: params.idempotencyKey,
      status: 'CAPTURED',
      amountMinorUnits: params.amountMinorUnits,
    };
    this.idempotencyStore.set(params.idempotencyKey, res);
    return res;
  }

  async refund(params: {
    idempotencyKey: string;
    pspRef: string;
    amountMinorUnits: number;
  }): Promise<PspRefundResponse> {
    await this.simulateNetwork();

    const cached = this.idempotencyStore.get(params.idempotencyKey) as
      PspRefundResponse | undefined;
    if (cached) {
      return cached;
    }

    const authRecord = this.transactions.get(params.pspRef);
    const refundRef = `psp_ref_${randomUUID().slice(0, 8)}`;

    const record: PspTransactionRecord = {
      pspRef: refundRef,
      idempotencyKey: params.idempotencyKey,
      rideId: authRecord?.rideId ?? 'unknown',
      kind: 'REFUND',
      amountMinorUnits: params.amountMinorUnits,
      status: 'SUCCESS',
      createdAt: new Date(),
    };
    this.transactions.set(refundRef, record);
    this.keyToPspRef.set(params.idempotencyKey, refundRef);

    const res: PspRefundResponse = {
      pspRef: params.pspRef,
      refundRef,
      idempotencyKey: params.idempotencyKey,
      status: 'REFUNDED',
      amountMinorUnits: params.amountMinorUnits,
    };
    this.idempotencyStore.set(params.idempotencyKey, res);
    return res;
  }

  async release(params: { idempotencyKey: string; pspRef: string }): Promise<PspReleaseResponse> {
    await this.simulateNetwork();

    const cached = this.idempotencyStore.get(params.idempotencyKey) as
      PspReleaseResponse | undefined;
    if (cached) {
      return cached;
    }

    const authRecord = this.transactions.get(params.pspRef);
    if (authRecord) {
      authRecord.status = 'SUCCESS';
    }

    const res: PspReleaseResponse = {
      pspRef: params.pspRef,
      idempotencyKey: params.idempotencyKey,
      status: 'RELEASED',
    };
    this.idempotencyStore.set(params.idempotencyKey, res);
    return res;
  }

  async queryByIdempotencyKey(key: string): Promise<PspTransactionRecord | null> {
    const pspRef = this.keyToPspRef.get(key);
    if (!pspRef) return null;
    return this.transactions.get(pspRef) ?? this.transactions.get(`cap_${pspRef}`) ?? null;
  }

  getAllRecords(): readonly PspTransactionRecord[] {
    return Array.from(this.transactions.values());
  }
}
