import { Worker } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import twilio from 'twilio';
import { elevenLabsClient } from '../lib/elevenlabs.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';

type CreateCallJob = import('./calls.queue.js').CreateCallJob;

const defaultConcurrency = Number(process.env.CALLS_WORKER_CONCURRENCY ?? '50');

export const callsWorker = new Worker<CreateCallJob>(
  'calls-create',
  async (job) => {
    // Apply personalized concurrency if specified
    const jobConcurrency = (job.data.payload as any)?.concurrency ?? defaultConcurrency;
    if (jobConcurrency !== defaultConcurrency) {
      // Note: This is a per-job setting, the worker concurrency is still global
      // For true per-job concurrency control, we'd need to implement job-specific workers
    }
    const { payload, jobType } = job.data;
    // Support dual call modes: trunk (ElevenLabs direct) or conference (Twilio AMD + bridge)
    const callMode = (job.data?.payload as any)?.callMode as 'trunk' | 'conference' | undefined;
    const gateMode = (job.data?.payload as any)?.gateMode as 'twilio_amd_bridge' | undefined; // Legacy fallback
    
    // Determine effective call mode
    let effectiveCallMode = callMode;
    if (!effectiveCallMode && gateMode === 'twilio_amd_bridge') {
      effectiveCallMode = 'conference';
    }
    
    console.log('Worker processing job with callMode:', effectiveCallMode, 'payload:', JSON.stringify(job.data?.payload));
    
    if (effectiveCallMode === 'conference' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      // Twilio-only for AMD detection. We will hand off to ElevenLabs after AMD=human via webhook.
      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
      const from = (job.data.payload as any).fromNumber || (env as any).TWILIO_DEFAULT_FROM || '+34881193139';
      const answerUrl = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/answer?workspaceId=${encodeURIComponent(payload.workspaceId)}&agentId=${encodeURIComponent(job.data.payload.agentId)}&to=${encodeURIComponent((job.data.payload as any).toNumber)}`;

      // Configure AMD options
      const amdOptions: any = {};
      
      // Apply personalized AMD settings (synchronous AMD)
      amdOptions.machineDetection = 'Enable';
      amdOptions.machineDetectionTimeout = payload.machineDetectionTimeout ?? 6;
      amdOptions.statusCallback = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/status`;
      amdOptions.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
      amdOptions.url = answerUrl;
      
      const twilioCall = await client.calls.create({
        to: job.data.payload.toNumber,
        from,
        ...amdOptions,
      });

      // Store Twilio Call SID into our Call row for later correlation in status webhook
      try {
        const call = await prisma.call.findFirst({
          where: {
            workspaceId: payload.workspaceId,
            agentId: payload.agentId,
            to: payload.toNumber,
            status: 'queued',
          },
          orderBy: { createdAt: 'desc' }
        });

        if (call) {
          await prisma.call.update({
            where: { id: call.id },
            data: {
              externalRef: twilioCall.sid,
              // keep queued until AMD result updates it
              campaignId: (payload as any).campaignId,
              metadata: {
                ...(call.metadata as any || {}),
                agentPhoneNumberId: (payload as any).agentPhoneNumberId,
                variables: (payload as any).variables,
              } as any,
            },
          });
        }
      } catch (e) {
        logger.warn({ err: e }, 'Failed to update call record with Twilio details');
      }

      logger.info({ jobId: job.id, jobType, mode: 'conference', twilioCallSid: twilioCall.sid }, 'Conference mode (Twilio AMD bridge) call created');
      return { callId: twilioCall.sid, status: 'queued' };
    }

    // Trunk mode: Direct ElevenLabs call with SIP REFER support
    logger.info({ jobId: job.id, jobType, mode: effectiveCallMode || 'trunk' }, 'Processing trunk mode (direct ElevenLabs) call');
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
      // Find the specific call record to avoid duplicates
      const call = await prisma.call.findFirst({
        where: {
          workspaceId: payload.workspaceId,
          agentId: payload.agentId,
          to: payload.toNumber,
          from: payload.fromNumber,
          status: 'queued',
        },
        orderBy: { createdAt: 'desc' }
      });

      if (call) {
        await prisma.call.update({
          where: { id: call.id },
          data: { externalRef: result.callId, status: result.status },
        });
      }
    } catch (e) {
      logger.warn({ err: e }, 'Failed to update call record');
    }
    return result;
  },
  {
    connection: redis,
    concurrency: defaultConcurrency,
  }
);

// Manual aggregate for a given date (YYYY-MM-DD)
export async function aggregateDailyFor(dateIso: string) {
  const dayStart = new Date(dateIso + 'T00:00:00.000Z');
  const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // 1. Agregar métricas básicas por workspace/agent
  const basicRows = await prisma.call.groupBy({
    by: ['workspaceId', 'agentId', 'status'],
    where: { createdAt: { gte: dayStart, lt: nextDay } },
    _count: { _all: true },
  });

  const key = (w: string, a: string) => `${w}::${a}`;
  const acc = new Map<string, { workspaceId: string; agentId: string; queued: number; in_progress: number; completed: number; failed: number }>();
  for (const r of basicRows) {
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

  // 2. Agregar métricas básicas por workspace/agent (avanzadas deshabilitadas temporalmente)
  for (const v of acc.values()) {
    await prisma.callDailyAggregate.upsert({
      where: { date_workspaceId_agentId: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId } },
      create: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId, queued: v.queued, in_progress: v.in_progress, completed: v.completed, failed: v.failed, total: v.queued + v.in_progress + v.completed + v.failed },
      update: { queued: v.queued, in_progress: v.in_progress, completed: v.completed, failed: v.failed, total: v.queued + v.in_progress + v.completed + v.failed },
    });
  }

  // 3. Agregar métricas por campaña (deshabilitado temporalmente)
  // await aggregateCampaignMetrics(dayStart, nextDay);
}

// Funciones de agregación avanzadas deshabilitadas temporalmente (dependen de campos no presentes en el schema)
// async function calculateAMDAggregatedStats(...) { return {}; }

// async function calculateQualityAggregatedStats(...) { return {}; }

// async function aggregateCampaignMetrics(...) {}

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


