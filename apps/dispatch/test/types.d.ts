declare module 'ioredis-mock' {
  import type Redis from 'ioredis';
  const RedisMock: new (...args: unknown[]) => Redis;
  export default RedisMock;
}
