import { Queue } from 'bullmq';
import type { QueueOptions } from 'bullmq';
import { redis } from '../lib/redis.js';

export type CreateCallJob = {
  jobType: 'PRIORITY' | 'BULK';
  payload: {
    callId: string;
    workspaceId: string;
    agentId: string;
    agentPhoneNumberId?: string;
    fromNumber: string;
    toNumber: string;
    campaignId?: string;
    metadata?: Record<string, unknown>;
    variables?: Record<string, unknown>;
    gateMode?: 'elevenlabs_direct' | 'twilio_amd_bridge' | 'twilio_amd_conference' | 'twilio_amd_stream';
    // AMD personalization options
    machineDetectionTimeout?: number;
    enableMachineDetection?: boolean;
    concurrency?: number;
  };
};

const queueName = 'calls-create';

const defaultOpts: QueueOptions = {
  connection: redis,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 1000,
    // Important: avoid duplicate dials due to automatic retries
    attempts: 1,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
};

export const callsQueue = new Queue<CreateCallJob>(queueName, defaultOpts);


