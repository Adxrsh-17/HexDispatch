import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const pingDuration = new Trend('location_ingest_duration_ms');
const pingsTotal = new Counter('location_pings_total_k6');

export const options = {
  scenarios: {
    sustained_pings: {
      executor: 'constant-vus',
      vus: 10,
      duration: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<150'], // 95% of requests should be below 150ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3002';

// Bangalore center coordinates
const BASE_LAT = 12.9716;
const BASE_LNG = 77.5946;

export default function () {
  // Each VU simulates a unique driver
  const driverIndex = __VU;
  const driverId = `00000000-0000-0000-0000-${String(driverIndex).padStart(12, '0')}`;

  // Slight delta based on iteration to simulate smooth movement (~11 m/s / 40 km/h)
  const lat = BASE_LAT + driverIndex * 0.01 + __ITER * 0.00001;
  const lng = BASE_LNG + driverIndex * 0.01;

  const payload = JSON.stringify({
    lat,
    lng,
    heading: 90,
    speedMps: 12.5,
    status: 'AVAILABLE',
    ts: new Date().toISOString(),
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': driverId,
    },
  };

  const start = Date.now();
  const res = http.post(`${BASE_URL}/drivers/me/location`, payload, params);
  const duration = Date.now() - start;

  pingDuration.add(duration);
  pingsTotal.add(1);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has valid cell': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body && typeof body.cell === 'string';
      } catch {
        return false;
      }
    },
  });

  // 100ms pause to simulate 10 pings/sec per driver
  sleep(0.1);
}
