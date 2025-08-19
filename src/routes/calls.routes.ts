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
  gateMode: z.enum(['elevenlabs_direct', 'twilio_amd_bridge', 'twilio_amd_conference', 'twilio_amd_stream']).optional(),
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
  gateMode: z.enum(['elevenlabs_direct', 'twilio_amd_bridge', 'twilio_amd_conference', 'twilio_amd_stream']).optional(),
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
  function getGateMode(request: any, bodyGateMode?: string | undefined): 'elevenlabs_direct' | 'twilio_amd_bridge' | 'twilio_amd_conference' | 'twilio_amd_stream' | undefined {
    const headerMode = (request.headers['x-gate-mode'] as string | undefined)?.trim();
    const queryMode = (request.query as any)?.mode as string | undefined;
    const mode = (bodyGateMode ?? headerMode ?? queryMode) as any;
    if (mode === 'elevenlabs_direct' || mode === 'twilio_amd_bridge' || mode === 'twilio_amd_conference' || mode === 'twilio_amd_stream') return mode;
    return undefined;
  }

  function buildConferenceName(callId: string) {
    return `conf-${callId}`;
  }

  function verifyTwilioSignatureOrFail(request: any) {
    const token = env.TWILIO_AUTH_TOKEN;
    if (!token) return true; // If not configured, skip
    const signature = request.headers['x-twilio-signature'] as string | undefined;
    if (!signature) {
      throw Object.assign(new Error('Missing Twilio signature'), { statusCode: 403 });
    }
    const url = `${env.PUBLIC_BASE_URL ?? ''}${request.raw.url}`;
    const params = request.body ?? {};
    const valid = twilio.validateRequest(token, signature, url, params);
    if (!valid) {
      throw Object.assign(new Error('Invalid Twilio signature'), { statusCode: 403 });
    }
    return true;
  }

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

    const gateMode = getGateMode(request, body.gateMode as any);
    logger.info({ route: 'priority', callId: call.id, requestedGateMode: gateMode, header: request.headers['x-gate-mode'], bodyGateMode: body.gateMode }, 'Selected gateMode for priority');
    if (gateMode === 'twilio_amd_bridge' || gateMode === 'twilio_amd_conference' || gateMode === 'twilio_amd_stream') {
      const { addPriorityCall } = await import('../queues/calls.worker.js');
      await addPriorityCall({
        jobType: 'PRIORITY',
        payload: {
          callId: call.id,
          workspaceId: body.workspaceId,
          agentId: body.agentId,
          ...(body.agentPhoneNumberId ? { agentPhoneNumberId: body.agentPhoneNumberId } : {}),
          fromNumber: body.fromNumber ?? '',
          toNumber: body.toNumber,
          ...(body.campaignId ? { campaignId: body.campaignId } : {}),
          ...(body.metadata ? { metadata: body.metadata } : {}),
          variables: withDefaultVariables(body.variables),
          gateMode,
          // Pass AMD personalization options
          ...(body.machineDetectionTimeout ? { machineDetectionTimeout: body.machineDetectionTimeout } : {}),
          ...(body.enableMachineDetection !== undefined ? { enableMachineDetection: body.enableMachineDetection } : {}),
          ...(body.concurrency ? { concurrency: body.concurrency } : {}),
        },
      });
      return reply.code(201).send({ created: true, callId: call.id, externalRef: null, mode: gateMode });
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
  app.all('/webhooks/twilio/answer', async (req, reply) => {
    const q = req.query as any;
    const callId = q?.callId as string | undefined;
    const mode = getGateMode(req) ?? (q?.mode as any);
    const callSidFromBody = (req.body as any)?.CallSid as string | undefined;
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    if (mode === 'twilio_amd_stream' && env.PUBLIC_WS_STREAM_URL && callId) {
      // Normalize to ws/wss scheme
      let base = env.PUBLIC_WS_STREAM_URL;
      if (base.startsWith('https://')) base = 'wss://' + base.slice('https://'.length);
      else if (base.startsWith('http://')) base = 'ws://' + base.slice('http://'.length);
      const streamUrl = `${base}?callId=${encodeURIComponent(callId)}&sid=${encodeURIComponent(callSidFromBody || '')}&agentId=${encodeURIComponent(q?.agentId || '')}`;
      logger.info({ callId, streamUrl }, 'Answer TwiML connecting media stream');
      const connect = (twiml as any).connect();
      connect.stream({ url: streamUrl });
      // Keep call active while stream is open
      twiml.pause({ length: 600 });
    } else {
      twiml.pause({ length: 60 });
    }
    reply.header('Content-Type', 'text/xml');
    return reply.send(twiml.toString());
  });

  // Twilio: AMD async callback
  app.post('/webhooks/twilio/amd', async (request, reply) => {
    verifyTwilioSignatureOrFail(request);
    const params = request.body as Record<string, string>;
    const callIdFromQuery = (request.query as any)?.callId as string | undefined;
    const workspaceId = (request.query as any)?.workspaceId as string | undefined;
    const agentId = (request.query as any)?.agentId as string | undefined;
    const to = (request.query as any)?.to as string | undefined;
    const result = (params['AnsweredBy'] || '').toLowerCase();
    const amdStatus = result.includes('human') ? 'human' : 'machine';
    const amdConfidence = params['AmdConfidence'] ? parseFloat(params['AmdConfidence']) : null;
    const twilioCallSid = params['CallSid'];
    
    logger.info({ 
      workspaceId, 
      agentId, 
      to, 
      amdStatus, 
      amdConfidence, 
      twilioCallSid,
      allParams: params 
    }, 'AMD callback received with full details');

    if (!callIdFromQuery && (!workspaceId || !agentId)) {
      logger.warn({ workspaceId, agentId }, 'AMD callback missing required query params');
      return reply.code(200).send('ok');
    }

    try {
      let call = callIdFromQuery
        ? await prisma.call.findUnique({ where: { id: callIdFromQuery } })
        : await prisma.call.findFirst({
            where: { workspaceId: workspaceId!, agentId: agentId!, ...(to ? { to } : {}), status: 'queued' },
            orderBy: { createdAt: 'desc' },
          });

      if (call) {
        logger.info({ 
          callId: call.id, 
          callTo: call.to, 
          callStatus: call.status, 
          callCreated: call.createdAt 
        }, 'Found matching call for AMD update');
        
        // Update AMD metrics and mark in_progress if human
        await prisma.call.update({
          where: { id: call.id },
          data: {
            amdStatus,
            amdConfidence,
            amdDetectionTime: 4,
            twilioCallSid: twilioCallSid || call.twilioCallSid || null,
            costTwilio: 0.025,
            ...(amdStatus === 'human' ? { status: 'in_progress' } : {}),
          },
        });

        logger.info({ 
          callId: call.id, 
          newStatus: amdStatus === 'human' ? 'in_progress' : call.status,
          twilioCallSid 
        }, 'Successfully updated call with AMD data');

        // For twilio_amd_stream: if machine -> hang up; if human -> leave stream running (answer already started it)
        if (true) {
          const requestedMode = getGateMode(request);
          try {
            if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
              logger.warn({ callId: call.id }, 'Twilio credentials missing; cannot update call TwiML');
            } else if (twilioCallSid) {
              const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
              const VoiceResponse = twilio.twiml.VoiceResponse;
              const twiml = new VoiceResponse();
              if (requestedMode === 'twilio_amd_stream' && env.PUBLIC_WS_STREAM_URL) {
                if (amdStatus === 'machine') {
                  twiml.hangup();
                  await client.calls(twilioCallSid).update({ twiml: twiml.toString() });
                  logger.info({ callId: call.id, twilioCallSid }, 'AMD detected machine: hanging up');
                } else {
                  // Human: do nothing; answer already started stream
                  logger.info({ callId: call.id, twilioCallSid }, 'AMD human: keeping stream running');
                }
              } else {
                const conferenceName = buildConferenceName(call.id);
                const dial = twiml.dial({});
                dial.conference({ endConferenceOnExit: true, beep: false } as any, conferenceName);
                await client.calls(twilioCallSid).update({ twiml: twiml.toString() });
                // Optionally dial ElevenLabs SIP into the conference
                try {
                  if (env.ELEVENLABS_SIP_URI) {
                    const fromNum = (env.TWILIO_FROM_FALLBACK || call.from || '+10000000000') as string;
                    const toSip = `sip:${env.ELEVENLABS_SIP_URI}`;
                    const participantTwiML = new twilio.twiml.VoiceResponse();
                    const d2 = participantTwiML.dial({});
                    d2.conference({ endConferenceOnExit: true, beep: false } as any, conferenceName);
                    await client.calls.create({ to: toSip, from: fromNum, twiml: participantTwiML.toString() });
                  }
                } catch (err) {
                  logger.error({ err, callId: call.id }, 'Failed to dial ElevenLabs into conference');
                }
                logger.info({ callId: call.id, twilioCallSid, conferenceName }, 'Updated call TwiML to conference');
              }
            }
          } catch (e) {
            logger.error({ err: e, callId: call.id, twilioCallSid }, 'Failed to update call TwiML after AMD');
          }
          // Do not return TwiML here; async AMD callback ignores it. Keep original call alive.
          return reply.code(200).send('ok');
        }
      } else {
        logger.warn({ callIdFromQuery, workspaceId, agentId, to, twilioCallSid }, 'No matching call found for AMD callback');
      }
    } catch (error) {
      logger.error({ error, workspaceId, agentId, to, twilioCallSid }, 'Failed to update AMD metrics');
    }

    return reply.code(200).send('ok');
  });

  // Twilio: Status callback webhook for call completion
  app.post('/webhooks/twilio/status', async (request, reply) => {
    verifyTwilioSignatureOrFail(request);
    const params = request.body as Record<string, string>;
    const callSid = params['CallSid'];
    const callStatus = params['CallStatus'];
    const callDuration = params['CallDuration'] ? parseInt(params['CallDuration']) : 0;
    const answeredBy = params['AnsweredBy'];
    const callIdFromQuery = (request.query as any)?.callId as string | undefined;
    
    logger.info({ 
      callSid, 
      callStatus, 
      callDuration, 
      answeredBy, 
      allParams: params 
    }, 'Twilio status callback received with full details');

    if (!callSid) {
      logger.warn('Status callback missing CallSid');
      return reply.code(200).send('ok');
    }

    try {
      const call = callIdFromQuery
        ? await prisma.call.findUnique({ where: { id: callIdFromQuery } })
        : await prisma.call.findFirst({ where: { twilioCallSid: callSid } });

      if (call) {
        logger.info({ 
          callId: call.id, 
          callTo: call.to, 
          currentStatus: call.status, 
          twilioCallSid: call.twilioCallSid 
        }, 'Found matching call for status update');
        
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
            costTwilio: callDuration > 0 ? (callDuration / 60) * 0.025 : 0.025,
            // Do not infer ElevenLabs cost from Twilio leg; leave as-is unless set elsewhere
            // Update call quality metrics if available (rudimentary placeholder)
            callQuality: callDuration > 0 ? 'good' : 'poor',
            mosScore: callDuration > 0 ? 4.0 : 1.0,
          },
        });

        logger.info({ 
          callId: call.id, 
          callSid, 
          oldStatus: call.status, 
          newStatus, 
          durationSeconds 
        }, 'Successfully updated call status');
      } else {
        logger.warn({ callIdFromQuery, callSid, callStatus }, 'No matching call found for status callback');
        
        // Also search without status filter to see if call exists at all
        const anyCall = await prisma.call.findFirst({
          where: { twilioCallSid: callSid }
        });
        
        if (anyCall) {
          logger.info({ 
            callId: anyCall.id, 
            callStatus: anyCall.status, 
            twilioCallSid: anyCall.twilioCallSid 
          }, 'Found call but status not in [queued, in_progress]');
        } else {
          logger.warn({ callSid }, 'No call found with this twilioCallSid at all');
        }
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
    const requestedGateMode = getGateMode(request, body.gateMode);
    const jobs: { jobType: 'BULK'; payload: any }[] = [];
    for (let idx = 0; idx < body.calls.length; idx++) {
      const c = body.calls[idx]!;
      const a = resolvedAgents[idx % resolvedAgents.length]!;
      const call = await prisma.call.create({
        data: {
          workspaceId: body.workspaceId,
          agentId: a.agentId,
          campaignId: body.campaignId ?? null,
          to: c.toNumber,
          from: a.fromNumber,
          status: 'queued',
          priority: 0,
          metadata: (c.metadata ?? null) as any,
        },
      });
      const payload: any = {
        callId: call.id,
        workspaceId: body.workspaceId,
        agentId: a.agentId,
        agentPhoneNumberId: a.agentPhoneNumberId,
        fromNumber: a.fromNumber,
        toNumber: c.toNumber,
        variables: withDefaultVariables(c.variables),
      };
      if (c.metadata) payload.metadata = c.metadata;
      if (body.campaignId) payload.campaignId = body.campaignId;
      // Decide gateMode: respect explicit request; otherwise default by capability
      payload.gateMode = requestedGateMode ?? (a.agentPhoneNumberId ? 'twilio_amd_conference' : 'elevenlabs_direct');
      logger.info({ route: 'bulk', callId: call.id, payloadMode: payload.gateMode, header: request.headers['x-gate-mode'], bodyGateMode: body.gateMode }, 'Enqueuing bulk call with gateMode');
      jobs.push({ jobType: 'BULK' as const, payload });
    }

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


