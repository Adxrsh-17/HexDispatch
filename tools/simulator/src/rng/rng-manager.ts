import { SeededRng } from './seeded-rng';

/**
 * 32-bit FNV-1a hash to derive stable sub-seeds from a master seed and a name string.
 */
function fnv1a32(seed: number, str: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export class RngManager {
  readonly demand: SeededRng;
  readonly driver: SeededRng;
  readonly acceptance: SeededRng;

  constructor(readonly masterSeed: number) {
    this.demand = new SeededRng(fnv1a32(masterSeed, 'substream:demand'));
    this.driver = new SeededRng(fnv1a32(masterSeed, 'substream:driver'));
    this.acceptance = new SeededRng(fnv1a32(masterSeed, 'substream:acceptance'));
  }

  /**
   * Derive a custom named sub-stream if additional isolated processes are needed.
   */
  derive(name: string): SeededRng {
    return new SeededRng(fnv1a32(this.masterSeed, `substream:${name}`));
  }
}
