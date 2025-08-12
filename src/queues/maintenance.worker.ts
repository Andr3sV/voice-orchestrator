import { Worker } from 'bullmq';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { aggregateDailyFor, purgeOldCalls } from './calls.worker.js';

import type { MaintenanceJob } from './maintenance.queue.js';

export const maintenanceWorker = new Worker<MaintenanceJob>(
  'maintenance',
  async (job) => {
    if (job.data.jobType === 'DAILY_AGGREGATE_PURGE') {
      const date = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await aggregateDailyFor(date);
      await purgeOldCalls();
      logger.info({ date }, 'Daily aggregate + purge completed');
      return { ok: true, date };
    }
  },
  { connection: redis, concurrency: 1 }
);

