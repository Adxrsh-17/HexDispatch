import { BatchedPolicy, GreedyPolicy, type MatchingPolicy } from '@hexdispatch/matching';

export class MatchingRegistry {
  private policies = new Map<string, MatchingPolicy>();

  constructor() {
    this.register(new GreedyPolicy());
    this.register(new BatchedPolicy());
  }

  register(policy: MatchingPolicy): void {
    this.policies.set(policy.name, policy);
  }

  get(name: string): MatchingPolicy {
    const policy = this.policies.get(name);
    if (!policy) {
      throw new Error(`Matching policy "${name}" not registered`);
    }
    return policy;
  }

  has(name: string): boolean {
    return this.policies.has(name);
  }
}
