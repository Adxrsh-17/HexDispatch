// Placeholder k6 script. Run with: k6 run tools/load-tests/smoke.js
// Replaced by real ping-ingest / ride-creation / WebSocket scenarios in Phases 2 and 9.
import http from 'k6/http';
import { check } from 'k6';

export const options = { vus: 1, iterations: 1 };

export default function () {
  const res = http.get(`${__ENV.BASE_URL || 'http://localhost:3000'}/health`);
  check(res, { 'health is 200': (r) => r.status === 200 });
}
