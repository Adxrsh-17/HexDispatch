import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type Redis from 'ioredis';
import {
  TOPICS,
  type OfferSentEvent,
  type OfferDeclinedEvent,
  type OfferExpiredEvent,
  type RideMatchedEvent,
} from '@hexdispatch/contracts';
import { AppError, createLogger, internalFetch } from '@hexdispatch/shared';
import { offers, matchDecisions, type Offer } from '../db/schema';
import type { DriverClaimService } from './driver-claim';
import { RideStateError, requestTransition } from './core-client';

const logger = createLogger({ service: 'offer-manager' });

export interface CreateOfferParams {
  rideId: string;
  driverId: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  pickupEtaSec: number;
  cost: number;
  policy?: string;
  batchId?: string | null;
  timeoutSec?: number;
}

export interface OfferManagerOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle db instance
  db: any;
  redis: Redis;
  claimService: DriverClaimService;
  producer?: {
    publish: (topic: string, key: string, payload: unknown) => Promise<void>;
  };
  coreApiUrl?: string;
  gatewayBroadcastUrl?: string;
  redisPubSub?: Redis;
  defaultOfferTimeoutSec?: number;
  onReofferNeeded?: (rideId: string, excludedDriverId: string) => Promise<void>;
  /** core-api says the ride can no longer be dispatched (cancelled, terminal). Stop working on it. */
  onRideGone?: (rideId: string) => void;
}

/**
 * Offer lifecycle. Accept, decline and expire all move an offer out of PENDING with the same
 * conditional `UPDATE ... WHERE status = 'PENDING'`, so exactly one of them wins and the losers
 * perform no side effects (no double match, no re-offer after an accept).
 * core-api owns trip state; every step that changes it checks the result.
 */
export class OfferManager {
  private activeTimers = new Map<string, NodeJS.Timeout>();
  private defaultTimeoutSec: number;

  constructor(private options: OfferManagerOptions) {
    this.defaultTimeoutSec = options.defaultOfferTimeoutSec ?? 15;
  }

  private offerKey(rideId: string, driverId: string): string {
    return `offer:${rideId}:${driverId}`;
  }

  async getOfferById(offerId: string): Promise<Offer | null> {
    const rows = await this.options.db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
    return rows[0] ?? null;
  }

  async createOffer(params: CreateOfferParams): Promise<Offer | null> {
    const offerId = randomUUID();
    const timeoutSec = params.timeoutSec ?? this.defaultTimeoutSec;

    // 1. Atomically claim driver
    const claimed = await this.options.claimService.acquireClaim(
      params.driverId,
      offerId,
      timeoutSec + 5,
      'OFFER',
    );

    if (!claimed) {
      return null;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeoutSec * 1000);

    // 2. Persist offer row
    const [inserted] = await this.options.db
      .insert(offers)
      .values({
        id: offerId,
        rideId: params.rideId,
        driverId: params.driverId,
        status: 'PENDING',
        pickupEtaSec: Math.round(params.pickupEtaSec),
        cost: params.cost,
        policy: params.policy ?? 'greedy',
        batchId: params.batchId ?? null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // 3. Tell core-api (source of truth): MATCHING -> OFFERED. If it refuses, undo everything.
    if (this.options.coreApiUrl) {
      try {
        await requestTransition(this.options.coreApiUrl, params.rideId, {
          to: 'OFFERED',
          actor: 'SYSTEM',
        });
      } catch (err) {
        await this.options.db
          .update(offers)
          .set({ status: 'FAILED', updatedAt: new Date() })
          .where(and(eq(offers.id, offerId), eq(offers.status, 'PENDING')));
        await this.options.claimService.releaseClaim(params.driverId, offerId);
        if (err instanceof RideStateError) {
          this.options.onRideGone?.(params.rideId);
        }
        throw err;
      }
    }

    // 4. Set Redis offer key
    await this.options.redis.set(
      this.offerKey(params.rideId, params.driverId),
      offerId,
      'PX',
      Math.max(50, Math.round(timeoutSec * 1000)),
    );

    // 5. Arm timeout timer
    this.armTimeoutTimer(offerId, timeoutSec * 1000);

    // 6. Publish offer.sent to Kafka (informational; a broker outage must not break dispatch)
    const offerSentEvent: OfferSentEvent = {
      eventId: randomUUID(),
      type: TOPICS.OFFER_SENT,
      version: 1,
      occurredAt: now.toISOString(),
      correlationId: offerId,
      payload: {
        offerId,
        rideId: params.rideId,
        driverId: params.driverId,
        expiresAt: expiresAt.toISOString(),
        pickup: params.pickup,
        dropoff: params.dropoff,
        pickupEtaSec: Math.round(params.pickupEtaSec),
      },
    };
    await this.publishSafely(TOPICS.OFFER_SENT, params.rideId, offerSentEvent);

    // 7. Broadcast over WebSocket to driver room
    await this.notifyRealtime(`driver:${params.driverId}`, 'OFFER_SENT', offerSentEvent.payload);

    return inserted;
  }

  async acceptOffer(offerId: string, driverId: string): Promise<Offer> {
    const offer = await this.getOfferById(offerId);
    if (!offer) {
      throw AppError.notFound(`Offer ${offerId} not found`);
    }

    if (offer.driverId !== driverId) {
      throw AppError.forbidden('Driver is not authorized to accept this offer');
    }

    // 1. Win the offer atomically (only one of accept/decline/expire can).
    const now = new Date();
    const [accepted] = await this.options.db
      .update(offers)
      .set({ status: 'ACCEPTED', updatedAt: now })
      .where(and(eq(offers.id, offerId), eq(offers.status, 'PENDING'), gt(offers.expiresAt, now)))
      .returning();

    if (!accepted) {
      const current = await this.getOfferById(offerId);
      if (current?.status === 'PENDING') {
        await this.expireOffer(offerId); // past its deadline but the timer has not fired yet
        throw AppError.conflict('Offer has expired');
      }
      throw AppError.conflict(`Offer cannot be accepted in status ${current?.status ?? 'unknown'}`);
    }

    this.clearTimeoutTimer(offerId);

    // 2. Upgrade driver claim to TRIP. If the claim is gone the driver may be double-booked.
    const upgraded = await this.options.claimService.upgradeClaim(
      driverId,
      offerId,
      offer.rideId,
      7200, // 2-hour trip claim
    );
    if (!upgraded) {
      await this.failAcceptedOffer(offer, { releaseClaim: false, reoffer: true });
      throw AppError.conflict('Driver claim was lost; offer cancelled');
    }

    // 3. core-api must accept OFFERED -> ASSIGNED, otherwise nothing below is true.
    if (this.options.coreApiUrl) {
      try {
        await requestTransition(this.options.coreApiUrl, offer.rideId, {
          to: 'ASSIGNED',
          actor: 'DRIVER',
          driverId: offer.driverId,
        });
      } catch (err) {
        const gone = err instanceof RideStateError;
        await this.failAcceptedOffer(offer, { releaseClaim: true, reoffer: !gone });
        if (gone) {
          this.options.onRideGone?.(offer.rideId);
          throw AppError.conflict('Ride can no longer be assigned (cancelled or already handled)');
        }
        throw err;
      }
    }

    // 4. Clean up Redis offer key
    await this.options.redis.del(this.offerKey(offer.rideId, offer.driverId));

    // 5. Record in match_decisions
    const decisionPolicy = accepted.policy ?? 'greedy';
    const decisionBatchId = accepted.batchId ?? null;
    await this.options.db.insert(matchDecisions).values({
      id: randomUUID(),
      rideId: offer.rideId,
      driverId: offer.driverId,
      policy: decisionPolicy,
      cost: offer.cost,
      batchId: decisionBatchId,
      createdAt: now,
    });

    // 6. Publish ride.matched to Kafka
    const matchEvent: RideMatchedEvent = {
      eventId: randomUUID(),
      type: TOPICS.RIDE_MATCHED,
      version: 1,
      occurredAt: now.toISOString(),
      correlationId: offerId,
      payload: {
        rideId: offer.rideId,
        driverId: offer.driverId,
        policy: decisionPolicy,
        cost: offer.cost,
        batchId: decisionBatchId,
      },
    };
    await this.publishSafely(TOPICS.RIDE_MATCHED, offer.rideId, matchEvent);

    // 7. Push to rider and driver over WebSocket
    await this.notifyRealtime(`ride:${offer.rideId}`, 'RIDE_MATCHED', matchEvent.payload);
    await this.notifyRealtime(`driver:${offer.driverId}`, 'RIDE_MATCHED', matchEvent.payload);

    return accepted;
  }

  async declineOffer(offerId: string, driverId: string, reason?: string): Promise<Offer> {
    const offer = await this.getOfferById(offerId);
    if (!offer) {
      throw AppError.notFound(`Offer ${offerId} not found`);
    }

    if (offer.driverId !== driverId) {
      throw AppError.forbidden('Driver is not authorized to decline this offer');
    }

    const updated = await this.closePendingOffer(offerId, 'DECLINED');
    if (!updated) {
      return (await this.getOfferById(offerId)) ?? offer; // already decided: idempotent
    }

    const declinedEvent: OfferDeclinedEvent = {
      eventId: randomUUID(),
      type: TOPICS.OFFER_DECLINED,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: offerId,
      payload: {
        offerId,
        rideId: offer.rideId,
        driverId,
        reason,
      },
    };
    await this.publishSafely(TOPICS.OFFER_DECLINED, offer.rideId, declinedEvent);
    await this.notifyRealtime(`driver:${driverId}`, 'OFFER_DECLINED', {
      offerId,
      rideId: offer.rideId,
    });

    await this.releaseRideAndReoffer(offer.rideId, driverId);
    return updated;
  }

  async expireOffer(offerId: string): Promise<Offer | null> {
    const offer = await this.getOfferById(offerId);
    if (!offer) {
      return null;
    }

    const updated = await this.closePendingOffer(offerId, 'EXPIRED');
    if (!updated) {
      return offer; // accepted, declined or expired already: nothing to do, no side effects
    }

    const expiredEvent: OfferExpiredEvent = {
      eventId: randomUUID(),
      type: TOPICS.OFFER_EXPIRED,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: offerId,
      payload: {
        offerId,
        rideId: offer.rideId,
        driverId: offer.driverId,
      },
    };
    await this.publishSafely(TOPICS.OFFER_EXPIRED, offer.rideId, expiredEvent);
    await this.notifyRealtime(`driver:${offer.driverId}`, 'OFFER_EXPIRED', {
      offerId,
      rideId: offer.rideId,
    });

    await this.releaseRideAndReoffer(offer.rideId, offer.driverId);
    return updated;
  }

  /**
   * Move a PENDING offer to a terminal status. Returns the updated row only for the single caller
   * that won; everyone else gets null and must do nothing.
   */
  private async closePendingOffer(
    offerId: string,
    status: 'DECLINED' | 'EXPIRED',
  ): Promise<Offer | null> {
    const [updated] = await this.options.db
      .update(offers)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(offers.id, offerId), eq(offers.status, 'PENDING')))
      .returning();
    if (!updated) return null;

    this.clearTimeoutTimer(offerId);
    await this.options.claimService.releaseClaim(updated.driverId, offerId);
    await this.options.redis.del(this.offerKey(updated.rideId, updated.driverId));
    return updated;
  }

  /** An accepted offer could not be completed. Undo it and (optionally) hand the ride back. */
  private async failAcceptedOffer(
    offer: Offer,
    opts: { releaseClaim: boolean; reoffer: boolean },
  ): Promise<void> {
    await this.options.db
      .update(offers)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(and(eq(offers.id, offer.id), eq(offers.status, 'ACCEPTED')));
    if (opts.releaseClaim) {
      // After upgradeClaim the claim owner is the ride id.
      await this.options.claimService.releaseClaim(offer.driverId, offer.rideId);
    }
    await this.options.redis.del(this.offerKey(offer.rideId, offer.driverId));
    if (opts.reoffer) {
      await this.releaseRideAndReoffer(offer.rideId, offer.driverId);
    }
  }

  /** OFFERED -> MATCHING in core-api, then let dispatch pick the next driver. */
  private async releaseRideAndReoffer(rideId: string, excludedDriverId: string): Promise<void> {
    if (this.options.coreApiUrl) {
      try {
        await requestTransition(this.options.coreApiUrl, rideId, {
          to: 'MATCHING',
          actor: 'SYSTEM',
        });
      } catch (err) {
        if (err instanceof RideStateError) {
          // Rider cancelled (or the ride is otherwise terminal): stop dispatching it.
          this.options.onRideGone?.(rideId);
          return;
        }
        logger.error({ err, rideId }, 'could not return ride to MATCHING; not re-offering');
        return;
      }
    }
    if (this.options.onReofferNeeded) {
      await this.options.onReofferNeeded(rideId, excludedDriverId);
    }
  }

  private async publishSafely(topic: string, key: string, event: unknown): Promise<void> {
    if (!this.options.producer) return;
    try {
      await this.options.producer.publish(topic, key, event);
    } catch (err) {
      logger.error({ err, topic, key }, 'kafka publish failed (informational event dropped)');
    }
  }

  /**
   * Recovery: re-arm pending offers on dispatch service restart.
   */
  async recoverPendingOffers(): Promise<{ recoveredCount: number; expiredCount: number }> {
    const pendingList = await this.options.db
      .select()
      .from(offers)
      .where(eq(offers.status, 'PENDING'));

    let recoveredCount = 0;
    let expiredCount = 0;
    const now = Date.now();

    for (const offer of pendingList) {
      const remainingMs = new Date(offer.expiresAt).getTime() - now;
      if (remainingMs <= 0) {
        await this.expireOffer(offer.id);
        expiredCount++;
      } else {
        this.armTimeoutTimer(offer.id, remainingMs);
        recoveredCount++;
      }
    }

    return { recoveredCount, expiredCount };
  }

  private armTimeoutTimer(offerId: string, delayMs: number): void {
    this.clearTimeoutTimer(offerId);
    const timer = setTimeout(
      () => {
        this.expireOffer(offerId).catch((err: unknown) => {
          logger.error({ err, offerId }, 'offer expiry failed');
        });
      },
      Math.max(10, delayMs),
    );
    this.activeTimers.set(offerId, timer);
  }

  private clearTimeoutTimer(offerId: string): void {
    const timer = this.activeTimers.get(offerId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(offerId);
    }
  }

  private async notifyRealtime(room: string, type: string, data: unknown): Promise<void> {
    // 1. Through Redis pubsub if available
    if (this.options.redisPubSub) {
      try {
        const payload = JSON.stringify({
          eventId: `${Date.now()}-0`,
          room,
          type,
          data,
          ts: new Date().toISOString(),
        });
        await this.options.redisPubSub.publish(`pubsub:room:${room}`, payload);
      } catch {
        // realtime fan-out is best effort
      }
    }

    // 2. Through Gateway HTTP broadcast endpoint if specified
    if (this.options.gatewayBroadcastUrl) {
      try {
        await internalFetch(`${this.options.gatewayBroadcastUrl}/events/broadcast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room, type, data }),
        });
      } catch {
        // realtime fan-out is best effort
      }
    }
  }

  stop(): void {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }
}
