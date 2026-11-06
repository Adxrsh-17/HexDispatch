import type Redis from 'ioredis';

export interface DriverClaim {
  driverId: string;
  ownerToken: string;
  type: 'OFFER' | 'TRIP';
  ttlSec: number;
}

const LUA_ACQUIRE_CLAIM = `
local key = KEYS[1]
local ownerToken = ARGV[1]
local ttl = tonumber(ARGV[2])
local claimType = ARGV[3] or "OFFER"

local existing = redis.call("GET", key)
if existing then
  return 0
end

redis.call("SET", key, ownerToken .. ":" .. claimType, "EX", ttl)
return 1
`;

const LUA_RELEASE_CLAIM = `
local key = KEYS[1]
local ownerToken = ARGV[1]

local current = redis.call("GET", key)
if not current then
  return 1
end

local split = string.find(current, ":")
local currentOwner = current
if split then
  currentOwner = string.sub(current, 1, split - 1)
end

if currentOwner == ownerToken then
  redis.call("DEL", key)
  return 1
else
  return 0
end
`;

const LUA_UPGRADE_CLAIM = `
local key = KEYS[1]
local expectedOwner = ARGV[1]
local newOwner = ARGV[2]
local ttl = tonumber(ARGV[3])

local current = redis.call("GET", key)
if not current then
  redis.call("SET", key, newOwner .. ":TRIP", "EX", ttl)
  return 1
end

local split = string.find(current, ":")
local currentOwner = current
if split then
  currentOwner = string.sub(current, 1, split - 1)
end

if currentOwner == expectedOwner then
  redis.call("SET", key, newOwner .. ":TRIP", "EX", ttl)
  return 1
else
  return 0
end
`;

export class DriverClaimService {
  constructor(private redis: Redis) {}

  private key(driverId: string): string {
    return `driver:claim:${driverId}`;
  }

  /**
   * Atomically acquire a claim on a driver (single Lua script, so check-and-set cannot interleave).
   * Returns true if claim succeeded, false if the driver is already claimed.
   * Redis errors propagate: there is deliberately no non-atomic fallback, because a "best effort"
   * GET-then-SET is exactly the double-assignment race this class exists to prevent.
   */
  async acquireClaim(
    driverId: string,
    ownerToken: string,
    ttlSeconds: number = 20,
    claimType: 'OFFER' | 'TRIP' = 'OFFER',
  ): Promise<boolean> {
    const result = await this.redis.eval(
      LUA_ACQUIRE_CLAIM,
      1,
      this.key(driverId),
      ownerToken,
      ttlSeconds,
      claimType,
    );
    return result === 1;
  }

  /**
   * Atomically release a claim if ownerToken matches.
   * Returns true if released or was not set, false if owned by another token.
   */
  async releaseClaim(driverId: string, ownerToken: string): Promise<boolean> {
    const result = await this.redis.eval(LUA_RELEASE_CLAIM, 1, this.key(driverId), ownerToken);
    return result === 1;
  }

  /**
   * Upgrades an offer claim to an active trip claim (longer TTL). Returns false if the claim is
   * now held by someone else, or has expired and been re-taken.
   */
  async upgradeClaim(
    driverId: string,
    expectedOwner: string,
    newOwner: string,
    ttlSeconds: number = 7200, // 2 hours for a trip
  ): Promise<boolean> {
    const result = await this.redis.eval(
      LUA_UPGRADE_CLAIM,
      1,
      this.key(driverId),
      expectedOwner,
      newOwner,
      ttlSeconds,
    );
    return result === 1;
  }

  async getClaim(driverId: string): Promise<string | null> {
    return this.redis.get(this.key(driverId));
  }

  async forceRelease(driverId: string): Promise<void> {
    await this.redis.del(this.key(driverId));
  }
}
