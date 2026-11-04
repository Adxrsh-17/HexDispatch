# Kafka Event Schemas & Domain Topics

All inter-service event communication in HexDispatch uses strict, strongly-typed Zod schemas published over Apache Kafka / Redpanda. Event envelope conventions enforce:

- `eventId`: UUIDv4 unique message identifier
- `type`: topic / event type matching contract constants
- `version`: integer schema version (default 1)
- `occurredAt`: ISO-8601 UTC timestamp
- `correlationId`: causal trace correlation identifier
- `payload`: typed event domain payload

---

## 1. Domain Topics Index

| Topic Constant (`TOPICS`) | Topic Name               | Partition Key | Emitting Service    | Primary Consumers                              |
| :------------------------ | :----------------------- | :------------ | :------------------ | :--------------------------------------------- |
| `RIDE_REQUESTED`          | `ride.requested`         | `rideId`      | `core-api` (Outbox) | `dispatch`                                     |
| `LOCATION_UPDATED`        | `location.updated`       | `driverId`    | `location`          | `dispatch`, `pricing`, `location` trust engine |
| `OFFER_SENT`              | `dispatch.offer.sent`    | `driverId`    | `dispatch`          | `gateway` (WebSocket)                          |
| `OFFER_EXPIRED`           | `dispatch.offer.expired` | `rideId`      | `dispatch`          | `dispatch`                                     |
| `MATCH_DECIDED`           | `dispatch.match.decided` | `rideId`      | `dispatch`          | `core-api` (Transition), `gateway`             |
| `TRIP_STATE_CHANGED`      | `trip.state.changed`     | `rideId`      | `core-api` (Outbox) | `dispatch`, `payment` (Saga), `gateway`        |
| `SURGE_UPDATED`           | `pricing.surge.updated`  | `cell`        | `pricing`           | `gateway`                                      |
| `TRUST_FLAGGED`           | `trust.flagged`          | `subjectId`   | `location`          | `gateway`, Audit register                      |

---

## 2. Event Payload Schemas

### \`ride.requested\`

Emitted when a rider successfully requests a ride.
\`\`\`json
{
"eventId": "123e4567-e89b-12d3-a456-426614174000",
"type": "ride.requested",
"version": 1,
"occurredAt": "2026-11-04T12:00:00.000Z",
"correlationId": "corr-9876",
"payload": {
"rideId": "48b61c92-698d-4767-827b-7b561c37b0cf",
"riderId": "11111111-1111-1111-1111-111111111111",
"pickup": { "lat": 12.9716, "lng": 77.5946 },
"dropoff": { "lat": 12.9352, "lng": 77.6245 },
"pickupCell": "88618925d3fffff",
"vehicleType": "standard",
"requestedAt": "2026-11-04T12:00:00.000Z"
}
}
\`\`\`

### \`location.updated\`

Emitted in batches by the location ingest pipeline.
\`\`\`json
{
"eventId": "223e4567-e89b-12d3-a456-426614174001",
"type": "location.updated",
"version": 1,
"occurredAt": "2026-11-04T12:00:01.000Z",
"correlationId": "corr-ping-1",
"payload": {
"driverId": "22222222-2222-2222-2222-222222222222",
"lat": 12.972,
"lng": 77.595,
"heading": 90,
"speedMps": 12.5,
"status": "AVAILABLE",
"ts": "2026-11-04T12:00:01.000Z"
}
}
\`\`\`

### \`trip.state.changed\`

Drives the distributed trip lifecycle and triggers the payments saga.
\`\`\`json
{
"eventId": "323e4567-e89b-12d3-a456-426614174002",
"type": "trip.state.changed",
"version": 1,
"occurredAt": "2026-11-04T12:05:00.000Z",
"correlationId": "corr-state-1",
"payload": {
"rideId": "48b61c92-698d-4767-827b-7b561c37b0cf",
"from": "IN_TRIP",
"to": "COMPLETED",
"version": 5,
"actor": "DRIVER",
"timestamp": "2026-11-04T12:05:00.000Z"
}
}
\`\`\`

### \`trust.flagged\`

Emitted when kinematic, teleportation, or cancellation abuse thresholds are violated.
\`\`\`json
{
"eventId": "423e4567-e89b-12d3-a456-426614174003",
"type": "trust.flagged",
"version": 1,
"occurredAt": "2026-11-04T12:10:00.000Z",
"correlationId": "corr-trust-1",
"payload": {
"subjectId": "22222222-2222-2222-2222-222222222222",
"subjectType": "DRIVER",
"reason": "IMPOSSIBLE_SPEED",
"riskScore": 85,
"details": { "speedMps": 80, "distanceMeters": 800, "deltaSec": 10 },
"flaggedAt": "2026-11-04T12:10:00.000Z"
}
}
\`\`\`
