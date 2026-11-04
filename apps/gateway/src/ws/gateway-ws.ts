import WebSocket from 'ws';
import type Redis from 'ioredis';
import { verifyToken, type AuthTokenPayload } from '@hexdispatch/shared';

export interface RoomEvent {
  eventId: string;
  room: string;
  type: string;
  data: unknown;
  ts: string;
}

function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq = '0'] = a.split('-');
  const [bMs, bSeq = '0'] = b.split('-');
  const msDiff = Number(aMs) - Number(bMs);
  if (msDiff !== 0) return msDiff;
  return Number(aSeq) - Number(bSeq);
}

export class RealtimeGateway {
  // room -> Set of local WebSockets
  private localRooms = new Map<string, Set<{ ws: WebSocket; user: AuthTokenPayload }>>();
  // ws -> Set of rooms subscribed
  private clientRooms = new Map<WebSocket, Set<string>>();
  // Active Redis pub/sub subscriptions
  private subscribedChannels = new Set<string>();

  constructor(
    private redisPub: Redis,
    private redisSub: Redis,
  ) {
    this.setupPubSub();
  }

  private setupPubSub(): void {
    if (!this.redisSub || typeof this.redisSub.on !== 'function') return;

    this.redisSub.on('message', (channel: string, messageStr: string) => {
      try {
        const room = channel.replace(/^pubsub:room:/, '');
        const event = JSON.parse(messageStr) as RoomEvent;
        this.fanoutLocally(room, event);
      } catch {
        // Ignore unparseable broadcast
      }
    });
  }

  private fanoutLocally(room: string, event: RoomEvent): void {
    const clients = this.localRooms.get(room);
    if (!clients) return;

    const payload = JSON.stringify(event);
    for (const { ws } of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  async authenticate(token: string): Promise<AuthTokenPayload> {
    return verifyToken(token);
  }

  async subscribe(
    ws: WebSocket,
    user: AuthTokenPayload,
    room: string,
    lastEventId?: string,
  ): Promise<void> {
    // Add to local room set
    if (!this.localRooms.has(room)) {
      this.localRooms.set(room, new Set());
    }
    this.localRooms.get(room)!.add({ ws, user });

    if (!this.clientRooms.has(ws)) {
      this.clientRooms.set(ws, new Set());
    }
    this.clientRooms.get(ws)!.add(room);

    // Ensure Redis pub/sub listens to this room channel
    const channel = `pubsub:room:${room}`;
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      try {
        await this.redisSub.subscribe(channel);
      } catch {
        // Fallback if in-memory mock
      }
    }

    // Replay missed events from Redis Stream if lastEventId was provided
    if (lastEventId) {
      await this.replayFromStream(ws, room, lastEventId);
    }
  }

  unsubscribe(ws: WebSocket, room: string): void {
    const roomSet = this.localRooms.get(room);
    if (roomSet) {
      for (const entry of roomSet) {
        if (entry.ws === ws) {
          roomSet.delete(entry);
          break;
        }
      }
      if (roomSet.size === 0) {
        this.localRooms.delete(room);
      }
    }

    const clientSet = this.clientRooms.get(ws);
    if (clientSet) {
      clientSet.delete(room);
    }
  }

  handleDisconnect(ws: WebSocket): void {
    const rooms = this.clientRooms.get(ws);
    if (rooms) {
      for (const room of rooms) {
        this.unsubscribe(ws, room);
      }
      this.clientRooms.delete(ws);
    }
  }

  /**
   * Publishes an event to a room:
   * 1. Records in bounded Redis Stream for replay capability (`lastEventId`).
   * 2. Broadcasts via Redis Pub/Sub for multi-node fan-out.
   */
  async broadcastToRoom(room: string, type: string, data: unknown): Promise<RoomEvent> {
    const streamKey = `stream:room:${room}`;
    const channel = `pubsub:room:${room}`;
    const ts = new Date().toISOString();
    let eventId = `${Date.now()}-0`;

    // 1. Append to bounded Redis stream (MAXLEN ~ 200)
    try {
      const addedId = await this.redisPub.xadd(
        streamKey,
        'MAXLEN',
        '~',
        200,
        '*',
        'type',
        type,
        'data',
        JSON.stringify(data),
        'ts',
        ts,
      );
      if (addedId) {
        eventId = addedId;
      }
    } catch {
      // Fallback for mocks
    }

    const event: RoomEvent = {
      eventId,
      room,
      type,
      data,
      ts,
    };

    // 2. Publish to Redis Pub/Sub channel
    try {
      await this.redisPub.publish(channel, JSON.stringify(event));
    } catch {
      // Direct local fanout on mock
      this.fanoutLocally(room, event);
    }

    return event;
  }

  private async replayFromStream(ws: WebSocket, room: string, lastEventId: string): Promise<void> {
    const streamKey = `stream:room:${room}`;
    try {
      let range: Array<[string, string[]]> = [];
      try {
        range = (await this.redisPub.xrange(streamKey, `(${lastEventId}`, '+')) as Array<
          [string, string[]]
        >;
      } catch {
        // Fallback for engines or mocks without '(' syntax
      }

      if (!range || range.length === 0) {
        const all = (await this.redisPub.xrange(streamKey, '-', '+')) as Array<[string, string[]]>;
        if (all && all.length > 0) {
          range = all.filter(([id]) => compareStreamIds(id, lastEventId) > 0);
        }
      }

      if (!range || range.length === 0) return;

      for (const [id, fields] of range) {
        let type = 'update';
        let data: unknown = null;
        let ts = new Date().toISOString();

        for (let i = 0; i < fields.length; i += 2) {
          const key = fields[i];
          const val = fields[i + 1];
          if (key === 'type' && val) type = val;
          if (key === 'ts' && val) ts = val;
          if (key === 'data' && val) {
            try {
              data = JSON.parse(val);
            } catch {
              data = val;
            }
          }
        }

        const replayEvent: RoomEvent = {
          eventId: id,
          room,
          type,
          data,
          ts,
        };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(replayEvent));
        }
      }
    } catch {
      // Replay unavailable or empty
    }
  }
}
