/** Kafka topic names. Single source of truth; never inline a topic string elsewhere. */
export const TOPICS = {
  LOCATION_UPDATED: 'location.updated',
  RIDE_REQUESTED: 'ride.requested',
  DISPATCH_BATCH_COMPLETED: 'dispatch.batch.completed',
  OFFER_SENT: 'offer.sent',
  OFFER_DECLINED: 'offer.declined',
  OFFER_EXPIRED: 'offer.expired',
  RIDE_MATCHED: 'ride.matched',
  TRIP_STATE_CHANGED: 'trip.state.changed',
  PRICING_SURGE_UPDATED: 'pricing.surge.updated',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',
  TRUST_FLAGGED: 'trust.flagged',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

/** What each topic is keyed by (decides partition, and therefore ordering). */
export const TOPIC_KEY: Record<Topic, string> = {
  'location.updated': 'driverId',
  'ride.requested': 'pickup H3 cell at H3_MATCHER_OWNER_RES (one region -> one partition)',
  'dispatch.batch.completed': 'region (owner cell)',
  'offer.sent': 'rideId',
  'offer.declined': 'rideId',
  'offer.expired': 'rideId',
  'ride.matched': 'rideId',
  'trip.state.changed': 'rideId',
  'pricing.surge.updated': 'H3 cell at H3_CELL_RES',
  'payment.authorized': 'rideId',
  'payment.captured': 'rideId',
  'payment.failed': 'rideId',
  'payment.refunded': 'rideId',
  'trust.flagged': 'subject id (driverId or riderId)',
};

/** One dead-letter topic per consumer group. */
export const dlqTopic = (consumerGroup: string): string => `dlq.${consumerGroup}`;
