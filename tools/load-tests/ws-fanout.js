import ws from 'k6/ws';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const wsConnectDuration = new Trend('ws_connect_duration_ms');
const wsMessagesReceived = new Counter('ws_messages_received_k6');
const wsPongs = new Counter('ws_pongs_k6');

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
  // A real signed JWT is passed in by the runner (WS_TOKEN). A bad token would still get a 101
  // upgrade and then be closed, which would make this test measure nothing.
  const url = `${WS_URL}?token=${__ENV.WS_TOKEN || ''}`;

  const start = Date.now();
  const res = ws.connect(url, {}, function (socket) {
    wsConnectDuration.add(Date.now() - start);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'ping' }));
    });

    socket.on('message', (data) => {
      wsMessagesReceived.add(1);
      try {
        if (JSON.parse(data).type === 'pong') wsPongs.add(1);
      } catch (e) {
        // ignore non-JSON frames
      }
    });

    socket.setTimeout(function () {
      socket.close();
    }, 2000);
  });

  check(res, { 'status is 101': (r) => r && r.status === 101 });
}
