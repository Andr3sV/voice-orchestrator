import { Redis } from 'ioredis';
import { env } from './env.js';

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  // BullMQ requires this to be null for blocking commands
  maxRetriesPerRequest: null,
});


