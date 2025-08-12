import { Queue } from 'bullmq';
import type { QueueOptions } from 'bullmq';
import { redis } from '../lib/redis.js';

export type CreateCallJob = {
  jobType: 'PRIORITY' | 'BULK';
  payload: {
    workspaceId: string;
    agentId: string;
    agentPhoneNumberId?: string;
    fromNumber: string;
    toNumber: string;
    metadata?: Record<string, unknown>;
    variables?: Record<string, unknown>;
  };
};

const queueName = 'calls-create';

const defaultOpts: QueueOptions = {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 1000,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
};

export const callsQueue = new Queue<CreateCallJob>(queueName, defaultOpts);


