import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { redis } from '../lib/redis.js';

export type MaintenanceJob = {
  jobType: 'DAILY_AGGREGATE_PURGE';
};

export const maintenanceQueue = new Queue<MaintenanceJob>('maintenance', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: true as const, removeOnFail: 100 as const },
});

export async function scheduleDailyAggregationIfNeeded() {
  const existing = await maintenanceQueue.getRepeatableJobs();
  const cron = '0 2 * * *'; // 02:00 every day UTC
  const found = existing.find((j) => j.name === 'daily-aggregate-purge' && j.pattern === cron);
  if (!found) {
    const opts: JobsOptions = {};
    (opts as any).repeat = { pattern: cron, tz: 'UTC' };
    await maintenanceQueue.add('daily-aggregate-purge', { jobType: 'DAILY_AGGREGATE_PURGE' }, opts);
  }
}
