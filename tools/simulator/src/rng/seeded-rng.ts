/**
 * Deterministic PRNG using the SFC32 algorithm (Simple Fast Counter 32-bit).
 * Initialized with 128-bit state derived from a single 32-bit seed via SplitMix32.
 * Strictly zero usage of Math.random().
 */

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class SeededRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly seed: number) {
    const sm = splitmix32(seed);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
    // Warm up the state
    for (let i = 0; i < 15; i++) {
      this.nextU32();
    }
  }

  /** Generates a 32-bit unsigned integer */
  private nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform random float in [0, 1) */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive */
  nextInt(min: number, max: number): number {
    if (min > max) {
      throw new Error(`min (${min}) cannot be greater than max (${max})`);
    }
    const range = max - min + 1;
    return min + Math.floor(this.next() * range);
  }

  /** Uniform float in [min, max) */
  nextFloat(min: number, max: number): number {
    if (min > max) {
      throw new Error(`min (${min}) cannot be greater than max (${max})`);
    }
    return min + this.next() * (max - min);
  }

  /**
   * Exponential distribution with rate lambda (> 0).
   * Used for Poisson inter-arrival times: interval = -ln(1 - U) / lambda.
   */
  nextExponential(lambda: number): number {
    if (lambda <= 0) {
      throw new Error(`Lambda must be positive, got ${lambda}`);
    }
    const u = Math.max(1e-12, 1 - this.next());
    return -Math.log(u) / lambda;
  }

  /**
   * Normal (Gaussian) distribution using Box-Muller transform.
   */
  nextNormal(mean = 0, stdDev = 1): number {
    let u1 = this.next();
    while (u1 <= 1e-12) {
      u1 = this.next();
    }
    const u2 = this.next();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * stdDev;
  }

  /** Bernoulli trial with probability p of returning true */
  boolean(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /** Uniform random pick from array */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from empty array');
    }
    const index = Math.floor(this.next() * items.length);
    return items[index]!;
  }

  /** Weighted random pick from items with positive weights */
  pickWeighted<T>(items: readonly { item: T; weight: number }[]): T {
    if (items.length === 0) {
      throw new Error('Cannot pick from empty weighted array');
    }
    let totalWeight = 0;
    for (const entry of items) {
      if (entry.weight < 0) {
        throw new Error(`Weights must be non-negative, got ${entry.weight}`);
      }
      totalWeight += entry.weight;
    }
    if (totalWeight <= 0) {
      return items[0]!.item;
    }

    const threshold = this.next() * totalWeight;
    let running = 0;
    for (const entry of items) {
      running += entry.weight;
      if (threshold <= running) {
        return entry.item;
      }
    }
    return items[items.length - 1]!.item;
  }
}
