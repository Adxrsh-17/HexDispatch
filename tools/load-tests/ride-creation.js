import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const rideCreationDuration = new Trend('ride_creation_duration_ms');
const ridesCreatedTotal = new Counter('rides_created_total_k6');

export const options = {
  scenarios: {
    sustained_rides: {
      executor: 'constant-vus',
      vus: 10,
      duration: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';

export default function () {
  const riderIndex = __VU;
  const riderId = `10000000-0000-0000-0000-${String(riderIndex).padStart(12, '0')}`;
  const idempotencyKey = `ride-k6-${riderIndex}-${__ITER}`;

  const payload = JSON.stringify({
    pickup: { lat: 12.9716, lng: 77.5946 },
    dropoff: { lat: 12.9352, lng: 77.6245 },
    vehicleType: 'standard',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': riderId,
      'idempotency-key': idempotencyKey,
    },
  };

  const start = Date.now();
  const res = http.post(`${BASE_URL}/rides`, payload, params);
  const duration = Date.now() - start;

  rideCreationDuration.add(duration);
  ridesCreatedTotal.add(1);

  check(res, {
    'status is 201': (r) => r.status === 201,
    'has ride id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body && typeof body.id === 'string';
      } catch {
        return false;
      }
    },
  });

  sleep(0.05);
}
