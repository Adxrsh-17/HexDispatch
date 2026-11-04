import { PriorityQueue } from './priority-queue';
import type { SimEvent, EventType } from './event';

export type EventHandler<TPayload = unknown> = (event: SimEvent<TPayload>) => void | Promise<void>;

export class DiscreteEngine {
  private queue = new PriorityQueue<SimEvent>();
  private seq = 0;
  private currentTime = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Generic event handlers map
  private handlers = new Map<EventType, EventHandler<any>>();

  get now(): number {
    return this.currentTime;
  }

  get queueSize(): number {
    return this.queue.size;
  }

  on<TPayload>(type: EventType, handler: EventHandler<TPayload>): void {
    this.handlers.set(type, handler);
  }

  schedule<TPayload>(type: EventType, delaySec: number, payload: TPayload): SimEvent<TPayload> {
    const scheduledTime = this.currentTime + Math.max(0, delaySec);
    return this.scheduleAt(type, scheduledTime, payload);
  }

  scheduleAt<TPayload>(type: EventType, timeSec: number, payload: TPayload): SimEvent<TPayload> {
    this.seq += 1;
    const event: SimEvent<TPayload> = {
      id: `evt-${this.seq}`,
      type,
      time: timeSec,
      seq: this.seq,
      payload,
    };
    this.queue.push(event);
    return event;
  }

  step(): boolean {
    const nextEvent = this.queue.pop();
    if (!nextEvent) return false;

    this.currentTime = nextEvent.time;
    const handler = this.handlers.get(nextEvent.type);
    if (handler) {
      handler(nextEvent);
    }
    return true;
  }

  runUntil(endTimeSec: number): void {
    while (!this.queue.isEmpty()) {
      const peek = this.queue.peek();
      if (!peek || peek.time > endTimeSec) {
        break;
      }
      this.step();
    }
    this.currentTime = Math.max(this.currentTime, endTimeSec);
  }

  reset(): void {
    this.queue.clear();
    this.seq = 0;
    this.currentTime = 0;
  }
}
