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
    // Support gateMode Twilio AMD bridge for bulk
    const gateMode = (job.data?.payload as any)?.gateMode as 'twilio_amd_bridge' | undefined;
    console.log('Worker processing job with gateMode:', gateMode, 'payload:', JSON.stringify(job.data?.payload));
    if (gateMode === 'twilio_amd_bridge' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
      // For AMD bridge, we need to use SIP trunk to get proper Caller ID presentation
      // Use ElevenLabs SIP trunk for the actual call, Twilio only for AMD detection
      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
      const from = (job.data.payload as any).fromNumber;
      const amdCallback = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/amd?workspaceId=${encodeURIComponent(payload.workspaceId)}&agentId=${encodeURIComponent(job.data.payload.agentId)}&to=${encodeURIComponent((job.data.payload as any).toNumber)}`;
      
      // Create call via ElevenLabs SIP trunk first
      const elevenLabsResult = await elevenLabsClient.createOutboundCall({
        workspaceId: payload.workspaceId,
        agentId: payload.agentId,
        agentPhoneNumberId: (payload as any).agentPhoneNumberId,
        fromNumber: payload.fromNumber,
        toNumber: payload.toNumber,
        metadata: payload.metadata,
        variables: (payload as any).variables,
      });

      // Update call record with ElevenLabs details and estimated costs
      try {
        // Find the specific call record to avoid duplicates
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
              externalRef: elevenLabsResult.callId,
              status: elevenLabsResult.status,
              campaignId: (payload as any).campaignId,
              // Initialize ElevenLabs cost (will be updated when call completes)
              costElevenLabs: 0.15, // Estimated cost per minute
            },
          });
        }
      } catch (e) {
        logger.warn({ err: e }, 'Failed to update call record with ElevenLabs details');
      }
      
      // Then use Twilio for AMD detection with personalized options
      const amdOptions: any = {};
      
      // Apply personalized AMD settings
      if (payload.enableMachineDetection !== false) { // Default to true if not specified
        amdOptions.machineDetection = 'Enable';
        amdOptions.machineDetectionTimeout = payload.machineDetectionTimeout ?? 6; // Default 6 seconds
        amdOptions.asyncAmd = 'true';
        amdOptions.asyncAmdStatusCallback = amdCallback;
        amdOptions.statusCallback = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/status`;
        amdOptions.statusCallbackEvent = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];
        amdOptions.url = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/answer`;
      } else {
        // If AMD is disabled, just connect the call directly
        amdOptions.statusCallback = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/status`;
        amdOptions.statusCallbackEvent = ['completed', 'no-answer', 'busy', 'failed', 'canceled'];
        amdOptions.url = `${env.PUBLIC_BASE_URL ?? ''}/webhooks/twilio/answer`;
      }
      
      await client.calls.create({
        to: job.data.payload.toNumber,
        from,
        ...amdOptions,
      });
      
      logger.info({ jobId: job.id, jobType, mode: 'twilio_amd_bridge', elevenLabsCallId: elevenLabsResult.callId }, 'Twilio AMD bridge call created');
      return { callId: elevenLabsResult.callId, status: elevenLabsResult.status };
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

  // 2. Agregar métricas avanzadas por workspace/agent
  for (const v of acc.values()) {
    // Obtener métricas AMD, costos y calidad para este workspace/agent en este día
    const advancedMetrics = await prisma.call.groupBy({
      by: ['workspaceId', 'agentId'],
      where: { 
        createdAt: { gte: dayStart, lt: nextDay },
        workspaceId: v.workspaceId,
        agentId: v.agentId
      },
      _count: { _all: true },
      _sum: {
        costTwilio: true,
        costElevenLabs: true,
        durationSeconds: true,
      },
      // Note: _group is not supported in this Prisma version, removing for now
    });

    if (advancedMetrics.length > 0) {
      const metrics = advancedMetrics[0];
      if (metrics) {
        const totalCalls = metrics._count._all || 0;
        const totalTwilioCost = metrics._sum.costTwilio || 0;
        const totalElevenLabsCost = metrics._sum.costElevenLabs || 0;
        const totalMinutes = metrics._sum.durationSeconds || 0;
        const totalCost = totalTwilioCost + totalElevenLabsCost;

        // Calcular métricas AMD
        const amdStats = await calculateAMDAggregatedStats(v.workspaceId, v.agentId, dayStart, nextDay);
        
        // Calcular métricas de costos
        const costMetrics = {
          twilio: totalTwilioCost,
          elevenLabs: totalElevenLabsCost,
          total: totalCost,
          costPerMinute: totalMinutes > 0 ? totalCost / (totalMinutes / 60) : 0,
          costPerCall: totalCalls > 0 ? totalCost / totalCalls : 0,
        };

        // Calcular métricas de calidad
        const qualityMetrics = await calculateQualityAggregatedStats(v.workspaceId, v.agentId, dayStart, nextDay);

        await prisma.callDailyAggregate.upsert({
          where: { date_workspaceId_agentId: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId } },
          create: { 
            date: dayStart, 
            workspaceId: v.workspaceId, 
            agentId: v.agentId, 
            queued: v.queued, 
            in_progress: v.in_progress, 
            completed: v.completed, 
            failed: v.failed, 
            total: v.queued + v.in_progress + v.completed + v.failed,
            amdStats,
            costMetrics,
            qualityMetrics,
            totalMinutes,
            totalCallsWithDuration: totalMinutes > 0 ? totalCalls : 0,
          },
          update: { 
            queued: v.queued, 
            in_progress: v.in_progress, 
            completed: v.completed, 
            failed: v.failed, 
            total: v.queued + v.in_progress + v.completed + v.failed,
            amdStats,
            costMetrics,
            qualityMetrics,
            totalMinutes,
            totalCallsWithDuration: totalMinutes > 0 ? totalCalls : 0,
          },
        });
      }
    } else {
      // Sin métricas avanzadas, solo básicas
      await prisma.callDailyAggregate.upsert({
        where: { date_workspaceId_agentId: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId } },
        create: { date: dayStart, workspaceId: v.workspaceId, agentId: v.agentId, queued: v.queued, in_progress: v.in_progress, completed: v.completed, failed: v.failed, total: v.queued + v.in_progress + v.completed + v.failed },
        update: { queued: v.queued, in_progress: v.in_progress, completed: v.completed, failed: v.failed, total: v.queued + v.in_progress + v.completed + v.failed },
      });
    }
  }

  // 3. Agregar métricas por campaña
  await aggregateCampaignMetrics(dayStart, nextDay);
}

// Función auxiliar para calcular estadísticas AMD agregadas
async function calculateAMDAggregatedStats(workspaceId: string, identifier: string, dayStart: Date, nextDay: Date, isCampaign: boolean = false) {
  const whereClause: any = { 
    createdAt: { gte: dayStart, lt: nextDay },
    workspaceId,
    amdStatus: { not: null }
  };

  if (isCampaign) {
    whereClause.campaignId = identifier;
  } else {
    whereClause.agentId = identifier;
  }

  const amdResults = await prisma.call.groupBy({
    by: ['amdStatus'],
    where: whereClause,
    _count: { _all: true },
  });

  const amdStats: Record<string, number> = {};
  let totalDetected = 0;

  for (const result of amdResults) {
    const status = result.amdStatus as string;
    const count = result._count._all || 0;
    amdStats[status] = count;
    totalDetected += count;
  }

  if (totalDetected > 0) {
    amdStats.totalDetected = totalDetected;
    amdStats.detectionRate = totalDetected / totalDetected; // 100% si hay detecciones
  }

  return amdStats;
}

// Función auxiliar para calcular estadísticas de calidad agregadas
async function calculateQualityAggregatedStats(workspaceId: string, identifier: string, dayStart: Date, nextDay: Date, isCampaign: boolean = false) {
  const whereClause: any = { 
    createdAt: { gte: dayStart, lt: nextDay },
    workspaceId,
    callQuality: { not: null }
  };

  if (isCampaign) {
    whereClause.campaignId = identifier;
  } else {
    whereClause.agentId = identifier;
  }

  const qualityResults = await prisma.call.groupBy({
    by: ['callQuality'],
    where: whereClause,
    _count: { _all: true },
    _avg: { mosScore: true },
  });

  const qualityStats: Record<string, any> = {};
  let totalRated = 0;
  let totalMOS = 0;
  let mosCount = 0;

  for (const result of qualityResults) {
    const quality = result.callQuality as string;
    const count = result._count._all || 0;
    const avgMOS = result._avg.mosScore || 0;
    
    qualityStats[quality] = count;
    totalRated += count;
    
    if (avgMOS > 0) {
      totalMOS += avgMOS;
      mosCount++;
    }
  }

  if (totalRated > 0) {
    qualityStats.totalRated = totalRated;
    qualityStats.averageMOS = mosCount > 0 ? totalMOS / mosCount : 0;
  }

  return qualityStats;
}

// Función para agregar métricas por campaña
async function aggregateCampaignMetrics(dayStart: Date, nextDay: Date) {
  const campaignRows = await prisma.call.groupBy({
    by: ['workspaceId', 'campaignId', 'status'],
    where: { 
      createdAt: { gte: dayStart, lt: nextDay },
      campaignId: { not: null }
    },
    _count: { _all: true },
  });

  const campaignKey = (w: string, c: string) => `${w}::${c}`;
  const campaignAcc = new Map<string, { workspaceId: string; campaignId: string; statusBreakdown: Record<string, number>; totalCalls: number }>();

  for (const r of campaignRows) {
    const id = campaignKey((r as any).workspaceId, (r as any).campaignId);
    const cur = campaignAcc.get(id) || { 
      workspaceId: (r as any).workspaceId, 
      campaignId: (r as any).campaignId, 
      statusBreakdown: {},
      totalCalls: 0
    };
    const status = (r as any).status as string;
    const count = (r as any)._count?._all ?? 0;
    (cur.statusBreakdown as Record<string, number>)[status] = ((cur.statusBreakdown as Record<string, number>)[status] || 0) + count;
    cur.totalCalls += count;
    campaignAcc.set(id, cur);
  }

  for (const v of campaignAcc.values()) {
    // Obtener métricas avanzadas por campaña
    const campaignMetrics = await prisma.call.groupBy({
      by: ['workspaceId', 'campaignId'],
      where: { 
        createdAt: { gte: dayStart, lt: nextDay },
        workspaceId: v.workspaceId,
        campaignId: v.campaignId
      },
      _sum: {
        costTwilio: true,
        costElevenLabs: true,
        durationSeconds: true,
      },
      // Note: _group is not supported in this Prisma version, removing for now
    });

    if (campaignMetrics.length > 0) {
      const metrics = campaignMetrics[0];
      if (metrics) {
        const totalCalls = v.totalCalls;
        const totalTwilioCost = metrics._sum.costTwilio || 0;
        const totalElevenLabsCost = metrics._sum.costElevenLabs || 0;
        const totalMinutes = metrics._sum.durationSeconds || 0;
        const totalCost = totalTwilioCost + totalElevenLabsCost;

        // Calcular métricas AMD por campaña
        const amdStats = await calculateAMDAggregatedStats(v.workspaceId, v.campaignId, dayStart, nextDay, true);
        
        // Calcular métricas de costos por campaña
        const costMetrics = {
          twilio: totalTwilioCost,
          elevenLabs: totalElevenLabsCost,
          total: totalCost,
          costPerMinute: totalMinutes > 0 ? totalCost / (totalMinutes / 60) : 0,
          costPerCall: totalCalls > 0 ? totalCost / totalCalls : 0,
        };

        // Calcular métricas de calidad por campaña
        const qualityMetrics = await calculateQualityAggregatedStats(v.workspaceId, v.campaignId, dayStart, nextDay, true);

        await prisma.campaignDailyAggregate.upsert({
          where: { date_workspaceId_campaignId: { date: dayStart, workspaceId: v.workspaceId, campaignId: v.campaignId } },
          create: { 
            date: dayStart, 
            workspaceId: v.workspaceId, 
            campaignId: v.campaignId, 
            totalCalls,
            totalMinutes,
            amdStats,
            costMetrics,
            qualityMetrics,
            statusBreakdown: v.statusBreakdown,
          },
          update: { 
            totalCalls,
            totalMinutes,
            amdStats,
            costMetrics,
            qualityMetrics,
            statusBreakdown: v.statusBreakdown,
          },
        });
      }
    }
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


