export interface TimedEvent {
  time: number;
  seq: number;
}

export class PriorityQueue<T extends TimedEvent> {
  private heap: T[] = [];

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): void {
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const bottom = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.heap = [];
  }

  private compare(a: T, b: T): number {
    if (a.time !== b.time) {
      return a.time - b.time;
    }
    return a.seq - b.seq;
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.compare(this.heap[current]!, this.heap[parent]!) < 0) {
        const temp = this.heap[current]!;
        this.heap[current] = this.heap[parent]!;
        this.heap[parent] = temp;
        current = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(index: number): void {
    let current = index;
    const length = this.heap.length;
    while ((current << 1) + 1 < length) {
      let smallest = current;
      const left = (current << 1) + 1;
      const right = left + 1;

      if (this.compare(this.heap[left]!, this.heap[smallest]!) < 0) {
        smallest = left;
      }
      if (right < length && this.compare(this.heap[right]!, this.heap[smallest]!) < 0) {
        smallest = right;
      }

      if (smallest !== current) {
        const temp = this.heap[current]!;
        this.heap[current] = this.heap[smallest]!;
        this.heap[smallest] = temp;
        current = smallest;
      } else {
        break;
      }
    }
  }
}
