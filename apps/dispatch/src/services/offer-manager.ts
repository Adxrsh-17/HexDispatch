import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import {
  TOPICS,
  type OfferSentEvent,
  type OfferDeclinedEvent,
  type OfferExpiredEvent,
  type RideMatchedEvent,
} from '@hexdispatch/contracts';
import { AppError } from '@hexdispatch/shared';
import { offers, matchDecisions, type Offer } from '../db/schema';
import type { DriverClaimService } from './driver-claim';

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
}

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

    // 3. Set Redis offer key
    await this.options.redis.set(
      this.offerKey(params.rideId, params.driverId),
      offerId,
      'PX',
      Math.max(50, Math.round(timeoutSec * 1000)),
    );

    // 4. Arm timeout timer
    this.armTimeoutTimer(offerId, timeoutSec * 1000);

    // 5. Publish offer.sent to Kafka
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

    if (this.options.producer) {
      await this.options.producer.publish(TOPICS.OFFER_SENT, params.rideId, offerSentEvent);
    }

    // 6. Broadcast over WebSocket to driver room
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

    if (offer.status !== 'PENDING') {
      throw AppError.conflict(`Offer cannot be accepted in status ${offer.status}`);
    }

    if (new Date() >= new Date(offer.expiresAt)) {
      await this.expireOffer(offerId);
      throw AppError.conflict('Offer has expired');
    }

    this.clearTimeoutTimer(offerId);

    // 1. Upgrade driver claim to TRIP
    await this.options.claimService.upgradeClaim(
      driverId,
      offerId,
      offer.rideId,
      7200, // 2-hour trip claim
    );

    // 2. Mark offer ACCEPTED
    const now = new Date();
    const [updated] = await this.options.db
      .update(offers)
      .set({ status: 'ACCEPTED', updatedAt: now })
      .where(eq(offers.id, offerId))
      .returning();

    // 3. Clean up Redis offer key
    await this.options.redis.del(this.offerKey(offer.rideId, offer.driverId));

    // 4. Record in match_decisions
    const decisionPolicy = updated.policy ?? 'greedy';
    const decisionBatchId = updated.batchId ?? null;
    await this.options.db.insert(matchDecisions).values({
      id: randomUUID(),
      rideId: offer.rideId,
      driverId: offer.driverId,
      policy: decisionPolicy,
      cost: offer.cost,
      batchId: decisionBatchId,
      createdAt: now,
    });

    // 5. Transition ride in core-api to ASSIGNED
    if (this.options.coreApiUrl) {
      try {
        await fetch(`${this.options.coreApiUrl}/rides/${offer.rideId}/transition`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            to: 'ASSIGNED',
            driverId: offer.driverId,
            actor: 'DRIVER',
          }),
        });
      } catch (err) {
        console.error(`Failed to transition ride ${offer.rideId} to ASSIGNED:`, err);
      }
    }

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

    if (this.options.producer) {
      await this.options.producer.publish(TOPICS.RIDE_MATCHED, offer.rideId, matchEvent);
    }

    // 7. Push to rider and driver over WebSocket
    await this.notifyRealtime(`ride:${offer.rideId}`, 'RIDE_MATCHED', matchEvent.payload);
    await this.notifyRealtime(`driver:${offer.driverId}`, 'RIDE_MATCHED', matchEvent.payload);

    return updated;
  }

  async declineOffer(offerId: string, driverId: string, reason?: string): Promise<Offer> {
    const offer = await this.getOfferById(offerId);
    if (!offer) {
      throw AppError.notFound(`Offer ${offerId} not found`);
    }

    if (offer.driverId !== driverId) {
      throw AppError.forbidden('Driver is not authorized to decline this offer');
    }

    if (offer.status !== 'PENDING') {
      return offer; // idempotent
    }

    this.clearTimeoutTimer(offerId);

    // 1. Release driver claim
    await this.options.claimService.releaseClaim(driverId, offerId);

    // 2. Mark offer DECLINED
    const now = new Date();
    const [updated] = await this.options.db
      .update(offers)
      .set({ status: 'DECLINED', updatedAt: now })
      .where(eq(offers.id, offerId))
      .returning();

    // 3. Clean up Redis offer key
    await this.options.redis.del(this.offerKey(offer.rideId, offer.driverId));

    // 4. Publish offer.declined to Kafka
    const declinedEvent: OfferDeclinedEvent = {
      eventId: randomUUID(),
      type: TOPICS.OFFER_DECLINED,
      version: 1,
      occurredAt: now.toISOString(),
      correlationId: offerId,
      payload: {
        offerId,
        rideId: offer.rideId,
        driverId,
        reason,
      },
    };

    if (this.options.producer) {
      await this.options.producer.publish(TOPICS.OFFER_DECLINED, offer.rideId, declinedEvent);
    }

    // 5. Notify WebSocket
    await this.notifyRealtime(`driver:${driverId}`, 'OFFER_DECLINED', {
      offerId,
      rideId: offer.rideId,
    });

    // 6. Trigger re-offer for this ride
    if (this.options.onReofferNeeded) {
      await this.options.onReofferNeeded(offer.rideId, driverId);
    }

    return updated;
  }

  async expireOffer(offerId: string): Promise<Offer | null> {
    const offer = await this.getOfferById(offerId);
    if (!offer || offer.status !== 'PENDING') {
      return offer;
    }

    this.clearTimeoutTimer(offerId);

    // 1. Release driver claim
    await this.options.claimService.releaseClaim(offer.driverId, offerId);

    // 2. Mark offer EXPIRED
    const now = new Date();
    const [updated] = await this.options.db
      .update(offers)
      .set({ status: 'EXPIRED', updatedAt: now })
      .where(eq(offers.id, offerId))
      .returning();

    // 3. Clean up Redis offer key
    await this.options.redis.del(this.offerKey(offer.rideId, offer.driverId));

    // 4. Publish offer.expired to Kafka
    const expiredEvent: OfferExpiredEvent = {
      eventId: randomUUID(),
      type: TOPICS.OFFER_EXPIRED,
      version: 1,
      occurredAt: now.toISOString(),
      correlationId: offerId,
      payload: {
        offerId,
        rideId: offer.rideId,
        driverId: offer.driverId,
      },
    };

    if (this.options.producer) {
      await this.options.producer.publish(TOPICS.OFFER_EXPIRED, offer.rideId, expiredEvent);
    }

    // 5. Notify WebSocket
    await this.notifyRealtime(`driver:${offer.driverId}`, 'OFFER_EXPIRED', {
      offerId,
      rideId: offer.rideId,
    });

    // 6. Trigger re-offer
    if (this.options.onReofferNeeded) {
      await this.options.onReofferNeeded(offer.rideId, offer.driverId);
    }

    return updated;
  }

  /**
   * Task 8 Recovery: Re-arm pending offers on dispatch service restart.
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
        void this.expireOffer(offerId);
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
        // ignore
      }
    }

    // 2. Through Gateway HTTP broadcast endpoint if specified
    if (this.options.gatewayBroadcastUrl) {
      try {
        await fetch(`${this.options.gatewayBroadcastUrl}/events/broadcast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room, type, data }),
        });
      } catch {
        // ignore
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
