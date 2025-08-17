import type { FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { env } from '../lib/env.js';
import { z } from 'zod';
import { addBulkCalls } from '../queues/calls.worker.js';
import { elevenLabsClient } from '../lib/elevenlabs.js';
import { prisma } from '../lib/prisma.js';
import { v4 as uuidv4 } from 'uuid';
import { aggregateDailyFor, purgeOldCalls } from '../queues/calls.worker.js';
import { metricsService } from '../lib/metrics.service.js';
import { logger } from '../lib/logger.js';

// Simple API key auth per workspace
async function authenticateWorkspace(request: any) {
  const authHeader = (request.headers?.authorization as string | undefined) ?? (request.headers?.['x-workspace-key'] as string | undefined);
  if (!authHeader) {
    throw Object.assign(new Error('Missing Authorization header'), { statusCode: 401 });
  }
  const apiKey = authHeader.startsWith('Bearer ')
    ? authHeader.substring('Bearer '.length).trim()
    : authHeader.trim();

  const ws = await prisma.workspace.findUnique({ where: { apiKey } });
  if (!ws) {
    throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
  }
  return ws;
}

function requireAdmin(request: any) {
  const hdr = (request.headers?.authorization as string | undefined) ?? '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : hdr.trim();
  const expected = process.env.ORCHESTRATOR_ADMIN_TOKEN ?? '';
  if (!expected || token !== expected) {
    const err: any = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

const createPrioritySchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  agentPhoneNumberId: z.string().optional(),
  fromNumber: z.string().min(5).optional(),
  toNumber: z.string().min(5),
  campaignId: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional() as unknown as z.ZodType<Record<string, unknown> | undefined>,
  variables: z.record(z.string(), z.unknown()).optional() as unknown as z.ZodType<Record<string, unknown> | undefined>,
  // AMD personalization options
  machineDetectionTimeout: z.number().min(1).max(30).optional(),
  enableMachineDetection: z.boolean().optional(),
  concurrency: z.number().min(1).max(100).optional(),
});

const bulkAgentEntrySchema = z.object({
  agentId: z.string().min(1),
  agentPhoneNumberId: z.string().optional(), // ElevenLabs phone id (phnum_...)
  fromNumber: z.string().min(5).optional(),  // E.164 to record in Call.from
});

const createBulkSchema = z.object({
  workspaceId: z.string().min(1),
  // Legacy single-agent fields (still supported)
  agentId: z.string().min(1).optional(),
  agentPhoneNumberId: z.string().optional(),
  fromNumber: z.string().min(5).optional(),
  // New multi-agent distribution
  agents: z.array(bulkAgentEntrySchema).optional(),
  gateMode: z.enum(['twilio_amd_bridge', 'twilio_amd_handoff']).optional(),
  campaignId: z.string().optional(),
  // AMD personalization options
  machineDetectionTimeout: z.number().min(1).max(30).optional(),
  enableMachineDetection: z.boolean().optional(),
  concurrency: z.number().min(1).max(100).optional(),
  calls: z
    .array(
      z.object({
        toNumber: z.string().min(5),
        metadata: z.record(z.string(), z.unknown()).optional() as unknown as z.ZodType<Record<string, unknown> | undefined>,
        variables: z.record(z.string(), z.unknown()).optional() as unknown as z.ZodType<Record<string, unknown> | undefined>,
      })
    )
    .max(100_000),
});

async function ensureWorkspaceAndAgent(workspaceId: string, agentId: string) {
  await prisma.workspace.upsert({
    where: { id: workspaceId },
    update: {},
    create: {
      id: workspaceId,
      name: workspaceId,
      apiKey: `auto_${uuidv4()}`,
    },
  });

  const existingAgent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!existingAgent) {
    await prisma.agent.create({
      data: {
        id: agentId,
        workspaceId,
        name: agentId,
        elevenLabsAgentId: agentId,
      },
    });
  }
}

async function ensureWorkspaceAndAgents(workspaceId: string, agentIds: string[]) {
  await prisma.workspace.upsert({
    where: { id: workspaceId },
    update: {},
    create: { id: workspaceId, name: workspaceId, apiKey: `auto_${uuidv4()}` },
  });
  const uniqueIds = Array.from(new Set(agentIds));
  const existing = await prisma.agent.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
  const existingSet = new Set(existing.map((a) => a.id));
  const toCreate = uniqueIds.filter((id) => !existingSet.has(id));
  if (toCreate.length > 0) {
    await prisma.agent.createMany({
      data: toCreate.map((id) => ({ id, workspaceId, name: id, elevenLabsAgentId: id })),
      skipDuplicates: true,
    });
  }
}

async function resolveDefaultPhoneForAgent(workspaceId: string, agentId: string): Promise<{ agentPhoneNumberId: string; fromNumber: string } | null> {
  // Find default mapping Agent -> WorkspacePhoneNumber with valid ElevenLabs id
  const links = await prisma.agentPhoneNumber.findMany({
    where: { agentId },
    include: { phoneNumber: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  for (const link of links) {
    if (link.phoneNumber.workspaceId !== workspaceId) continue;
    if (!link.phoneNumber.active) continue;
    const elId = (link.phoneNumber as any).elevenLabsPhoneNumberId as string | null;
    const e164 = link.phoneNumber.e164;
    if (elId && e164) return { agentPhoneNumberId: elId, fromNumber: e164 };
  }
  // Fallback: pick any active workspace phone number with elevenLabsPhoneNumberId
  const anyPhone = await prisma.workspacePhoneNumber.findFirst({
    where: { workspaceId, active: true, elevenLabsPhoneNumberId: { not: null } as any },
  });
  if (anyPhone && anyPhone.elevenLabsPhoneNumberId) {
    return { agentPhoneNumberId: anyPhone.elevenLabsPhoneNumberId, fromNumber: anyPhone.e164 } as any;
  }
  return null;
}

function withDefaultVariables(vars?: Record<string, unknown>): Record<string, unknown> {
  const out = { ...(vars ?? {}) } as Record<string, unknown>;
  if (out.businessName == null) out.businessName = 'Restaurante Andres';
  return out;
}

// New schemas for GET endpoints
const listCallsQuerySchema = z.object({
  workspaceId: z.string().min(1),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  status: z.string().optional(),
  agentId: z.string().optional(),
  campaignId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

const reportQuerySchema = z.object({
  workspaceId: z.string().min(1),
  from: z.string().datetime(),
  to: z.string().datetime(),
  groupBy: z.enum(['day', 'agent', 'campaign']).default('day'),
});

export async function registerCallsRoutes(app: FastifyInstance) {
  // Parse x-www-form-urlencoded for Twilio webhooks
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, payload, done) => {
    try {
      const params = new URLSearchParams((payload as string) || '');
      const obj: Record<string, string> = {};
      params.forEach((v, k) => { obj[k] = v; });
      done(null, obj);
    } catch (e) {
      done(e as Error, undefined as any);
    }
  });
  // Admin: provision or fetch workspace API key
  app.post('/workspaces/provision', async (request, reply) => {
    requireAdmin(request);
    const schema = z.object({ workspaceId: z.string().min(1), name: z.string().optional() });
    const { workspaceId, name } = schema.parse(request.body ?? {});
    const existing = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (existing) {
      return reply.send({ workspaceId: existing.id, apiKey: existing.apiKey });
    }
    const created = await prisma.workspace.create({
      data: { id: workspaceId, name: name ?? workspaceId, apiKey: `auto_${uuidv4()}` },
    });
    return reply.code(201).send({ workspaceId: created.id, apiKey: created.apiKey });
  });

  // Admin: inspect workspace (masked apiKey)
  app.get('/workspaces/:id', async (request, reply) => {
    requireAdmin(request);
    const schema = z.object({ id: z.string().min(1) });
    const params = schema.parse(request.params);
    const ws = await prisma.workspace.findUnique({ where: { id: params.id } });
    if (!ws) return reply.code(404).send({ error: 'Not found' });
    const masked = ws.apiKey.length > 6 ? `${ws.apiKey.slice(0, 3)}***${ws.apiKey.slice(-3)}` : '***';
    return reply.send({ id: ws.id, name: ws.name, apiKeyMasked: masked });
  });

  // Create campaign (workspace-auth)
  app.post('/campaigns', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      id: z.string().optional(),
      externalId: z.string().optional(),
      name: z.string().optional(),
      status: z.string().optional(),
    });
    const body = schema.parse(request.body ?? {});
    if (body.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    const created = await prisma.campaign.create({
      data: {
        // Let DB generate id when undefined by omitting the field
        ...(body.id ? { id: body.id } : {}),
        workspaceId: body.workspaceId,
        ...(body.externalId !== undefined ? { externalId: body.externalId } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        status: body.status ?? 'active',
      },
    });
    return reply.code(201).send(created);
  });

  // Manual daily aggregate + purge endpoint
  app.post('/calls/aggregate/run', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({ date: z.string().date().optional() });
    const { date } = schema.parse(request.body ?? {});
    const target = date ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await aggregateDailyFor(target);
    await purgeOldCalls();
    return reply.send({ ok: true, date: target });
  });

  // Manage workspace phone numbers (create/update)
  app.post('/workspaces/phone-numbers', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      e164: z.string().min(5),
      label: z.string().optional(),
      active: z.boolean().optional(),
      elevenLabsPhoneNumberId: z.string().optional(),
    });
    const body = schema.parse(request.body ?? {});
    if (body.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    const updateData: any = {};
    if (body.label !== undefined) updateData.label = body.label;
    if (body.active !== undefined) updateData.active = body.active;
    if (body.elevenLabsPhoneNumberId !== undefined) updateData.elevenLabsPhoneNumberId = body.elevenLabsPhoneNumberId;
    const rec = await prisma.workspacePhoneNumber.upsert({
      where: { workspaceId_e164: { workspaceId: body.workspaceId, e164: body.e164 } },
      update: updateData,
      create: { workspaceId: body.workspaceId, e164: body.e164, label: body.label ?? null, active: body.active ?? true, elevenLabsPhoneNumberId: body.elevenLabsPhoneNumberId ?? null },
    });
    return reply.code(201).send({ id: rec.id, e164: rec.e164, elevenLabsPhoneNumberId: (rec as any).elevenLabsPhoneNumberId ?? null });
  });

  // List workspace phone numbers
  app.get('/workspaces/:workspaceId/phone-numbers', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const params = z.object({ workspaceId: z.string().min(1) }).parse(request.params);
    if (params.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    const rows = await prisma.workspacePhoneNumber.findMany({ where: { workspaceId: params.workspaceId }, orderBy: { createdAt: 'desc' } });
    return reply.send(rows.map((r) => ({ id: r.id, e164: r.e164, active: r.active, label: r.label, elevenLabsPhoneNumberId: (r as any).elevenLabsPhoneNumberId ?? null })));
  });

  // Link agent to a workspace phone number (optionally mark as default)
  app.post('/agents/phone-links', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      agentId: z.string().min(1),
      phoneNumberId: z.string().optional(),
      e164: z.string().min(5).optional(),
      isDefault: z.boolean().optional(),
    });
    const body = schema.parse(request.body ?? {});
    if (body.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    if (!body.phoneNumberId && !body.e164) return reply.code(400).send({ error: 'Provide phoneNumberId or e164' });
    const phone = body.phoneNumberId
      ? await prisma.workspacePhoneNumber.findFirst({ where: { id: body.phoneNumberId, workspaceId: body.workspaceId } })
      : await prisma.workspacePhoneNumber.findFirst({ where: { workspaceId: body.workspaceId, e164: body.e164! } });
    if (!phone) return reply.code(404).send({ error: 'Phone number not found in workspace' });
    await ensureWorkspaceAndAgent(body.workspaceId, body.agentId);
    const updateLink: any = {};
    if (body.isDefault !== undefined) updateLink.isDefault = body.isDefault;
    const link = await prisma.agentPhoneNumber.upsert({
      where: { agentId_phoneNumberId: { agentId: body.agentId, phoneNumberId: phone.id } },
      update: updateLink,
      create: { agentId: body.agentId, phoneNumberId: phone.id, isDefault: body.isDefault ?? false },
    });
    if (body.isDefault) {
      // unset others for this agent
      await prisma.agentPhoneNumber.updateMany({ where: { agentId: body.agentId, id: { not: link.id } }, data: { isDefault: false } });
    }
    return reply.code(201).send({ id: link.id, agentId: link.agentId, phoneNumberId: link.phoneNumberId, isDefault: link.isDefault });
  });

  // List agent phone links
  app.get('/agents/:agentId/phone-links', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const params = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const q = z.object({ workspaceId: z.string().min(1) }).parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    const links = await prisma.agentPhoneNumber.findMany({ where: { agentId: params.agentId }, include: { phoneNumber: true } });
    const items = links
      .filter((l) => l.phoneNumber.workspaceId === q.workspaceId)
      .map((l) => ({ id: l.id, isDefault: l.isDefault, e164: l.phoneNumber.e164, phoneNumberId: l.phoneNumberId, elevenLabsPhoneNumberId: (l.phoneNumber as any).elevenLabsPhoneNumberId ?? null }));
    return reply.send(items);
  });

  // List paginated calls
  app.get('/calls', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const q = listCallsQuerySchema.parse(request.query);

    if (q.workspaceId !== ws.id) {
      return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    }

    const where: any = { workspaceId: q.workspaceId };
    if (q.status) where.status = q.status;
    if (q.agentId) where.agentId = q.agentId;
    if (q.campaignId) where.campaignId = q.campaignId;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) where.createdAt.gte = new Date(q.from);
      if (q.to) where.createdAt.lte = new Date(q.to);
    }

    const [total, items] = await Promise.all([
      prisma.call.count({ where }),
      prisma.call.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          workspaceId: true,
          agentId: true,
          campaignId: true,
          to: true,
          from: true,
          status: true,
          externalRef: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return reply.send({ page: q.page, pageSize: q.pageSize, total, items });
  });

  // Aggregated report
  app.get('/calls/report', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const q = reportQuerySchema.parse(request.query);
    if (q.workspaceId !== ws.id) {
      return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    }
    const from = new Date(q.from);
    const to = new Date(q.to);

    if (q.groupBy === 'day') {
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `
        SELECT
          to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE status = 'queued') AS queued,
          COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'failed') AS failed
        FROM "Call"
        WHERE "workspaceId" = $1 AND "createdAt" BETWEEN $2 AND $3
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        q.workspaceId,
        from,
        to
      );
      const totals = rows.reduce(
        (acc, r) => {
          acc.queued += Number(r.queued);
          acc.in_progress += Number(r.in_progress);
          acc.completed += Number(r.completed);
          acc.failed += Number(r.failed);
          return acc;
        },
        { queued: 0, in_progress: 0, completed: 0, failed: 0 }
      );
      return reply.send({ totals, groups: rows.map((r) => ({ key: r.day, queued: Number(r.queued), in_progress: Number(r.in_progress), completed: Number(r.completed), failed: Number(r.failed) })) });
    }

    if (q.groupBy === 'agent') {
      const rows = await prisma.call.groupBy({
        by: ['agentId'],
        where: { workspaceId: q.workspaceId, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      });
      return reply.send({
        totals: { count: rows.reduce((s, r) => s + (r._count?._all ?? 0), 0) },
        groups: rows.map((r) => ({ key: r.agentId, count: r._count?._all ?? 0 })),
      });
    }

    // campaign
    const rows = await prisma.call.groupBy({
      by: ['campaignId'],
      where: { workspaceId: q.workspaceId, createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    return reply.send({
      totals: { count: rows.reduce((s, r) => s + (r._count?._all ?? 0), 0) },
      groups: rows.map((r) => ({ key: r.campaignId, count: r._count?._all ?? 0 })),
    });
  });

  // Priority create (on-time)
  app.post('/calls/priority', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const body = createPrioritySchema.parse(request.body);
    if (body.workspaceId !== ws.id) {
      return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    }
    await ensureWorkspaceAndAgent(body.workspaceId, body.agentId);
    // Ensure campaign exists if provided
    if (body.campaignId) {
      await prisma.campaign.upsert({
        where: { id: body.campaignId },
        update: {},
        create: { id: body.campaignId, workspaceId: body.workspaceId, name: body.campaignId, status: 'active' },
      });
    }

    const call = await prisma.call.create({
      data: {
        workspaceId: body.workspaceId,
        agentId: body.agentId,
        campaignId: body.campaignId ?? null,
        to: body.toNumber,
        from: body.fromNumber ?? '',
        status: 'queued',
        priority: 10,
        metadata: body.metadata as any,
      },
    });

    const gateMode = (request.headers['x-gate-mode'] as string | undefined) ?? (request as any).body?.gateMode;
    // For AMD bridge, send to worker; otherwise process directly
    if (gateMode === 'twilio_amd_bridge') {
      // Send to worker for AMD bridge processing
      const { addPriorityCall } = await import('../queues/calls.worker.js');
      await addPriorityCall({
        jobType: 'PRIORITY',
        payload: {
          workspaceId: body.workspaceId,
          agentId: body.agentId,
          ...(body.agentPhoneNumberId ? { agentPhoneNumberId: body.agentPhoneNumberId } : {}),
          fromNumber: body.fromNumber ?? '',
          toNumber: body.toNumber,
          ...(body.campaignId ? { campaignId: body.campaignId } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
          variables: withDefaultVariables(body.variables),
          // Pass AMD personalization options
          ...(body.machineDetectionTimeout ? { machineDetectionTimeout: body.machineDetectionTimeout } : {}),
          ...(body.enableMachineDetection !== undefined ? { enableMachineDetection: body.enableMachineDetection } : {}),
          ...(body.concurrency ? { concurrency: body.concurrency } : {}),
        },
      });
      return reply.code(201).send({ created: true, callId: call.id, externalRef: null, mode: 'twilio_amd_bridge' });
    }

    // Process direct calls normally
    if (process.env.DISABLE_WORKERS === '1') {
      return reply.code(201).send({ created: true, callId: call.id, externalRef: null, note: 'Workers disabled: outbound skipped' });
    }

    const result = await elevenLabsClient.createOutboundCall({
      workspaceId: body.workspaceId,
      agentId: body.agentId,
      agentPhoneNumberId: body.agentPhoneNumberId,
      fromNumber: body.fromNumber,
      toNumber: body.toNumber,
      metadata: body.metadata,
      variables: withDefaultVariables(body.variables),
    });

    await prisma.call.update({
      where: { id: call.id },
      data: { externalRef: result.callId, status: result.status },
    });

    return reply.code(201).send({ created: true, callId: call.id, externalRef: result.callId });
  });

  // Twilio: basic answer webhook (TwiML)
  app.all('/webhooks/twilio/answer', async (_req, reply) => {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.pause({ length: 1 });
    reply.header('Content-Type', 'text/xml');
    return reply.send(twiml.toString());
  });

  // Twilio: AMD async callback
  app.post('/webhooks/twilio/amd', async (request, reply) => {
    const params = request.body as Record<string, string>;
    const workspaceId = (request.query as any)?.workspaceId as string | undefined;
    const agentId = (request.query as any)?.agentId as string | undefined;
    const to = (request.query as any)?.to as string | undefined;
    const result = (params['AnsweredBy'] || '').toLowerCase();
    const amdStatus = result.includes('human') ? 'human' : 'machine';
    const amdConfidence = params['AmdConfidence'] ? parseFloat(params['AmdConfidence']) : null;
    
    logger.info({ workspaceId, agentId, to, amdStatus, amdConfidence }, 'AMD callback received');

    if (!workspaceId || !agentId) return reply.code(200).send('ok');

    try {
      // Match latest queued call for this workspace/agent/(to)
      const call = await prisma.call.findFirst({
        where: { 
          workspaceId,
          agentId,
          ...(to ? { to } : {}),
          status: 'queued',
        },
        orderBy: { createdAt: 'desc' }
      });

      if (call) {
        // Update AMD metrics and mark in_progress if human
        await prisma.call.update({
          where: { id: call.id },
          data: {
            amdStatus,
            amdConfidence,
            amdDetectionTime: 4,
            twilioCallSid: params['CallSid'] || call.twilioCallSid || null,
            costTwilio: 0.025,
            ...(amdStatus === 'human' ? { status: 'in_progress' } : {}),
          },
        });

        if (amdStatus === 'human') {
          const VoiceResponse = twilio.twiml.VoiceResponse;
          const twiml = new VoiceResponse();
          twiml.dial({}, '+34881556005');
          reply.header('Content-Type', 'text/xml');
          return reply.send(twiml.toString());
        }
      }
    } catch (error) {
      logger.error({ error, workspaceId, agentId, to }, 'Failed to update AMD metrics');
    }

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.hangup();
    reply.header('Content-Type', 'text/xml');
    return reply.send(twiml.toString());
  });

  // Twilio: Status callback webhook for call completion
  app.post('/webhooks/twilio/status', async (request, reply) => {
    const params = request.body as Record<string, string>;
    const callSid = params['CallSid'];
    const callStatus = params['CallStatus'];
    const callDuration = params['CallDuration'] ? parseInt(params['CallDuration']) : 0;
    const answeredBy = params['AnsweredBy'];
    
    logger.info({ callSid, callStatus, callDuration, answeredBy }, 'Twilio status callback received');

    if (!callSid) return reply.code(200).send('ok');

    try {
      // Find the call record using the Twilio Call SID
      const call = await prisma.call.findFirst({
        where: { 
          twilioCallSid: callSid,
          status: { in: ['queued', 'in_progress'] }
        }
      });

      if (call) {
        // Map Twilio status to our internal status
        let newStatus: string;
        let durationSeconds: number | null = null;

        switch (callStatus) {
          case 'completed':
            newStatus = 'completed';
            durationSeconds = callDuration;
            break;
          case 'no-answer':
            newStatus = 'no_answer';
            break;
          case 'busy':
            newStatus = 'busy';
            break;
          case 'failed':
            newStatus = 'failed';
            break;
          case 'canceled':
            newStatus = 'canceled';
            break;
          default:
            newStatus = 'failed';
        }

        // Update the call record with final status and duration
        await prisma.call.update({
          where: { id: call.id },
          data: {
            status: newStatus,
            durationSeconds: durationSeconds,
            // Update costs based on duration
            costTwilio: callDuration > 0 ? (callDuration / 60) * 0.025 : 0.025, // Twilio cost per minute
            costElevenLabs: callDuration > 0 ? (callDuration / 60) * 0.15 : 0.15, // ElevenLabs cost per minute
            // Update call quality metrics if available
            callQuality: callDuration > 0 ? 'good' : 'poor',
            mosScore: callDuration > 0 ? 4.0 : 1.0, // Default MOS score
          },
        });

        logger.info({ 
          callId: call.id, 
          callSid, 
          oldStatus: call.status, 
          newStatus, 
          durationSeconds 
        }, 'Call status updated');
      }
    } catch (error) {
      logger.error({ error, callSid, callStatus }, 'Failed to update call status');
    }

    return reply.code(200).send('ok');
  });

  // Bulk create (queued)
  app.post('/calls/bulk', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const body = createBulkSchema.parse(request.body);
    if (body.workspaceId !== ws.id) {
      return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    }
    // Ensure campaign exists if provided
    if (body.campaignId) {
      await prisma.campaign.upsert({
        where: { id: body.campaignId },
        update: {},
        create: { id: body.campaignId, workspaceId: body.workspaceId, name: body.campaignId, status: 'active' },
      });
    }
    // Determine agent list: new multi-agent mode or legacy single-agent mode
    let agentsList: { agentId: string; agentPhoneNumberId?: string | undefined; fromNumber?: string | undefined }[] = [];
    if (body.agents && body.agents.length > 0) {
      agentsList = body.agents;
      await ensureWorkspaceAndAgents(body.workspaceId, agentsList.map((a) => a.agentId));
    } else if (body.agentId) {
      agentsList = [{ agentId: body.agentId!, agentPhoneNumberId: body.agentPhoneNumberId, fromNumber: body.fromNumber }];
      await ensureWorkspaceAndAgent(body.workspaceId, body.agentId);
    } else {
      return reply.code(400).send({ error: 'Provide either agentId or agents[]' });
    }

    // Resolve defaults where needed
    const resolvedAgents: { agentId: string; agentPhoneNumberId: string; fromNumber: string }[] = [];
    const missing: string[] = [];
    for (const a of agentsList) {
      if (a.agentPhoneNumberId && a.fromNumber) {
        resolvedAgents.push({ agentId: a.agentId, agentPhoneNumberId: a.agentPhoneNumberId, fromNumber: a.fromNumber });
        continue;
      }
      if (a.agentPhoneNumberId && !a.fromNumber) {
        // Allow missing fromNumber for Twilio flow; we'll store empty from in Call
        resolvedAgents.push({ agentId: a.agentId, agentPhoneNumberId: a.agentPhoneNumberId, fromNumber: '' });
        continue;
      }
      const r = await resolveDefaultPhoneForAgent(body.workspaceId, a.agentId);
      if (!r) missing.push(a.agentId);
      else resolvedAgents.push({ agentId: a.agentId, agentPhoneNumberId: a.agentPhoneNumberId ?? r.agentPhoneNumberId, fromNumber: a.fromNumber ?? r.fromNumber });
    }
    if (missing.length > 0) {
      return reply.code(400).send({ error: 'Missing phone mapping for agents', agents: missing });
    }

    // Distribute calls round-robin among resolved agents
    if (resolvedAgents.length === 0) {
      return reply.code(400).send({ error: 'No agents resolved' });
    }
    const jobs = body.calls.map((c, idx) => {
      const a = resolvedAgents[idx % resolvedAgents.length]!;
      const payload: {
        workspaceId: string;
        agentId: string;
        agentPhoneNumberId?: string;
        fromNumber: string;
        toNumber: string;
        metadata?: Record<string, unknown>;
        variables: Record<string, unknown>;
        campaignId?: string;
        gateMode?: 'twilio_amd_bridge' | 'twilio_amd_handoff';
      } = {
        workspaceId: body.workspaceId,
        agentId: a.agentId,
        agentPhoneNumberId: a.agentPhoneNumberId,
        fromNumber: a.fromNumber,
        toNumber: c.toNumber,
        variables: withDefaultVariables(c.variables),
      };
      if (c.metadata) payload.metadata = c.metadata;
      if (body.campaignId) payload.campaignId = body.campaignId;
      // For bulk calls, default to twilio_amd_bridge when agentPhoneNumberId is present
      if (a.agentPhoneNumberId) {
        payload.gateMode = 'twilio_amd_bridge';
      }
      return { jobType: 'BULK' as const, payload };
    });

    await prisma.call.createMany({
      data: jobs.map((j) => ({
        workspaceId: j.payload.workspaceId,
        agentId: j.payload.agentId,
        campaignId: j.payload.campaignId ?? null,
        to: j.payload.toNumber,
        from: j.payload.fromNumber,
        status: 'queued',
        priority: 0,
        metadata: (j.payload.metadata ?? null) as any,
      })),
    });

    if (process.env.DISABLE_WORKERS === '1') {
      return reply.code(202).send({ enqueued: jobs.length, agents: resolvedAgents.map(a => ({ agentId: a.agentId, fromNumber: a.fromNumber })), note: 'Workers disabled: queue skipped' });
    }
    const res = await addBulkCalls(jobs);
    return reply.code(202).send({ enqueued: res.length, agents: resolvedAgents.map(a => ({ agentId: a.agentId, fromNumber: a.fromNumber })) });
  });

  // Usage: total minutes/seconds by campaign
  app.get('/calls/usage', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      campaignId: z.string().min(1),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    });
    const q = schema.parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });

    const where: any = { workspaceId: q.workspaceId, campaignId: q.campaignId };
    if (q.from || q.to) {
      where.createdAt = {} as any;
      if (q.from) where.createdAt.gte = new Date(q.from);
      if (q.to) where.createdAt.lte = new Date(q.to);
    }

    const rows = await prisma.call.findMany({ where, select: { durationSeconds: true, status: true } });
    const totalSeconds = rows.reduce((s, r) => s + (r.durationSeconds ?? 0), 0);
    const completed = rows.filter((r) => r.status === 'completed').length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    return reply.send({ totalSeconds, totalMinutes: Math.round(totalSeconds / 60), completed, failed });
  });

  // ===== NEW ADVANCED METRICS ENDPOINTS =====

  // AMD Statistics by workspace or campaign
  app.get('/calls/amd-stats', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      campaignId: z.string().min(1).optional(),
      from: z.string().datetime(),
      to: z.string().datetime(),
    });
    const q = schema.parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });

    try {
      const stats = await metricsService.getAMDStats({
        workspaceId: q.workspaceId,
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        from: new Date(q.from),
        to: new Date(q.to),
      });
      return reply.send(stats);
    } catch (error) {
      logger.error({ error }, 'Failed to get AMD stats');
      return reply.code(500).send({ error: 'Failed to get AMD stats' });
    }
  });

  // Cost Analysis by workspace or campaign
  app.get('/calls/cost-analysis', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      campaignId: z.string().min(1).optional(),
      from: z.string().datetime(),
      to: z.string().datetime(),
    });
    const q = schema.parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });

    try {
      const costs = await metricsService.getCostMetrics({
        workspaceId: q.workspaceId,
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        from: new Date(q.from),
        to: new Date(q.to),
      });
      return reply.send(costs);
    } catch (error) {
      logger.error({ error }, 'Failed to get cost analysis');
      return reply.code(500).send({ error: 'Failed to get cost analysis' });
    }
  });

  // Quality Metrics by workspace or campaign
  app.get('/calls/quality-metrics', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      campaignId: z.string().min(1).optional(),
      from: z.string().datetime(),
      to: z.string().datetime(),
    });
    const q = schema.parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });

    try {
      const quality = await metricsService.getQualityMetrics({
        workspaceId: q.workspaceId,
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        from: new Date(q.from),
        to: new Date(q.to),
      });
      return reply.send(quality);
    } catch (error) {
      logger.error({ error }, 'Failed to get quality metrics');
      return reply.code(500).send({ error: 'Failed to get quality metrics' });
    }
  });

  // Comprehensive Campaign Dashboard
  app.get('/calls/campaign-dashboard', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      campaignId: z.string().min(1),
      from: z.string().datetime(),
      to: z.string().datetime(),
    });
    const q = schema.parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });

    try {
      const dashboard = await metricsService.getCampaignDashboard({
        workspaceId: q.workspaceId,
        campaignId: q.campaignId,
        from: new Date(q.from),
        to: new Date(q.to),
      });
      return reply.send(dashboard);
    } catch (error) {
      logger.error({ error }, 'Failed to get campaign dashboard');
      return reply.code(500).send({ error: 'Failed to get campaign dashboard' });
    }
  });

  // Workspace Overview Dashboard
  app.get('/calls/workspace-overview', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const schema = z.object({
      workspaceId: z.string().min(1),
      from: z.string().datetime(),
      to: z.string().datetime(),
    });
    const q = schema.parse(request.query);
    if (q.workspaceId !== ws.id) return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });

    try {
      const overview = await metricsService.getWorkspaceOverview({
        workspaceId: q.workspaceId,
        from: new Date(q.from),
        to: new Date(q.to),
      });
      return reply.send(overview);
    } catch (error) {
      logger.error({ error }, 'Failed to get workspace overview');
      return reply.code(500).send({ error: 'Failed to get workspace overview' });
    }
  });
}


