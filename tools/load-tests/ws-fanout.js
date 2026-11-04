import ws from 'k6/ws';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const wsConnectDuration = new Trend('ws_connect_duration_ms');
const wsMessagesReceived = new Counter('ws_messages_received_k6');

export const options = {
  scenarios: {
    ws_connections: {
      executor: 'constant-vus',
      vus: 10,
      duration: '5s',
    },
  },
  thresholds: {
    ws_connect_duration_ms: ['p(95)<250'],
  },
};

const WS_URL = __ENV.WS_URL || 'ws://127.0.0.1:3000/ws';

export default function () {
  const userId = `20000000-0000-0000-0000-${String(__VU).padStart(12, '0')}`;
  const url = `${WS_URL}?token=mock-jwt-rider-${userId}`;

  const start = Date.now();
  const res = ws.connect(url, {}, function (socket) {
    wsConnectDuration.add(Date.now() - start);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'PING' }));
    });

    socket.on('message', () => {
      wsMessagesReceived.add(1);
    });

    socket.setTimeout(function () {
      socket.close();
    }, 2000);
  });

  check(res, { 'status is 101': (r) => r && r.status === 101 });
}
