import { Worker } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import twilio from 'twilio';
import { elevenLabsClient } from '../lib/elevenlabs.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';

type CreateCallJob = import('./calls.queue.js').CreateCallJob;

const concurrency = Number(process.env.CALLS_WORKER_CONCURRENCY ?? '50');

export const callsWorker = new Worker<CreateCallJob>(
  'calls-create',
  async (job) => {
    const { payload, jobType } = job.data;
    // Support gateMode Twilio AMD bridge for bulk
    const gateMode = (job.data?.payload as any)?.gateMode as 'twilio_amd_bridge' | undefined;
    if (gateMode === 'twilio_amd_bridge' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
      const from = (job.data.payload as any).fromNumber;
      const amdCallback = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/amd?agentId=${encodeURIComponent(job.data.payload.agentId)}`;
      await client.calls.create({
        to: job.data.payload.toNumber,
        from,
        machineDetection: 'Enable',
        machineDetectionTimeout: 4,
        asyncAmd: 'true',
        asyncAmdStatusCallback: amdCallback,
        url: `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/answer`,
      });
      logger.info({ jobId: job.id, jobType, mode: 'twilio_amd_bridge' }, 'Twilio AMD call created');
      return { callId: 'twilio-bridge', status: 'queued' as const };
    }

    const result = await elevenLabsClient.createOutboundCall({
      workspaceId: payload.workspaceId,
      agentId: payload.agentId,
      agentPhoneNumberId: (payload as any).agentPhoneNumberId,
      fromNumber: payload.fromNumber,
      toNumber: payload.toNumber,
      metadata: payload.metadata,
      variables: (payload as any).variables,
    });
    logger.info({ jobId: job.id, jobType, result }, 'Call created');
    try {
      await prisma.call.updateMany({
        where: {
          workspaceId: payload.workspaceId,
          agentId: payload.agentId,
          to: payload.toNumber,
          from: payload.fromNumber,
          status: 'queued',
        },
        data: { externalRef: result.callId, status: result.status },
      });
    } catch (e) {
      logger.warn({ err: e }, 'Failed to update call record');
    }
    return result;
  },
  {
    connection: redis,
    concurrency,
  }
);

// Manual aggregate for a given date (YYYY-MM-DD)
export async function aggregateDailyFor(dateIso: string) {
  const dayStart = new Date(dateIso + 'T00:00:00.000Z');
  const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const rows = await prisma.call.groupBy({
    by: ['workspaceId', 'agentId', 'status'],
    where: { createdAt: { gte: dayStart, lt: nextDay } },
    _count: { _all: true },
  });

  const key = (w: string, a: string) => `${w}::${a}`;
  const acc = new Map<string, { workspaceId: string; agentId: string; queued: number; in_progress: number; completed: number; failed: number }>();
  for (const r of rows) {
    const id = key((r as any).workspaceId, (r as any).agentId);
    const cur = acc.get(id) || { workspaceId: (r as any).workspaceId, agentId: (r as any).agentId, queued: 0, in_progress: 0, completed: 0, failed: 0 };
    const status = (r as any).status as string;
    const count = (r as any)._count?._all ?? 0;
    if (status === 'queued') cur.queued += count;
    else if (status === 'in_progress') cur.in_progress += count;
    else if (status === 'completed') cur.completed += count;
    else if (status === 'failed') cur.failed += count;
    acc.set(id, cur);
  }

  for (const v of acc.values()) {
    await prisma.callDailyAggregate.upsert({
      where: { date_workspaceId_agentId: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId } },
      create: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId, queued: v.queued, in_progress: v.in_progress, completed: v.completed, failed: v.failed, total: v.queued + v.in_progress + v.completed + v.failed },
      update: { queued: v.queued, in_progress: v.in_progress, completed: v.completed, failed: v.failed, total: v.queued + v.in_progress + v.completed + v.failed },
    });
  }
}

// Purge old calls beyond retention window
export async function purgeOldCalls() {
  const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await prisma.call.deleteMany({ where: { createdAt: { lt: cutoff } } });
  logger.info({ deleted: deleted.count, cutoff }, 'Purged old calls');
}

export function addPriorityCall(job: CreateCallJob, opts?: JobsOptions) {
  return import('./calls.queue.js').then(({ callsQueue }) =>
    callsQueue.add('priority', job, {
      priority: 1,
      lifo: true,
      ...opts,
    })
  );
}

export function addBulkCalls(jobs: CreateCallJob[], opts?: JobsOptions) {
  return import('./calls.queue.js').then(({ callsQueue }) =>
    callsQueue.addBulk(
      jobs.map((data, idx) => ({ name: `bulk-${idx}`, data, opts: { priority: 5, ...opts } }))
    )
  );
}


