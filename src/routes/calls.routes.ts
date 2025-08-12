import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addBulkCalls } from '../queues/calls.worker.js';
import { elevenLabsClient } from '../lib/elevenlabs.js';
import { prisma } from '../lib/prisma.js';
import { v4 as uuidv4 } from 'uuid';
import { aggregateDailyFor, purgeOldCalls } from '../queues/calls.worker.js';

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
  metadata: z.record(z.string(), z.unknown()).optional() as unknown as z.ZodType<Record<string, unknown> | undefined>,
  variables: z.record(z.string(), z.unknown()).optional() as unknown as z.ZodType<Record<string, unknown> | undefined>,
});

const createBulkSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  agentPhoneNumberId: z.string().optional(),
  fromNumber: z.string().min(5).optional(),
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
    const call = await prisma.call.create({
      data: {
        workspaceId: body.workspaceId,
        agentId: body.agentId,
        to: body.toNumber,
        from: body.fromNumber ?? '',
        status: 'queued',
        priority: 10,
        metadata: body.metadata as any,
      },
    });

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

  // Bulk create (queued)
  app.post('/calls/bulk', async (request, reply) => {
    const ws = await authenticateWorkspace(request);
    const body = createBulkSchema.parse(request.body);
    if (body.workspaceId !== ws.id) {
      return reply.code(403).send({ error: 'Forbidden: workspaceId mismatch' });
    }
    await ensureWorkspaceAndAgent(body.workspaceId, body.agentId);
    const jobs = body.calls.map((c) => {
      const payload: {
        workspaceId: string;
        agentId: string;
        agentPhoneNumberId?: string;
        fromNumber: string;
        toNumber: string;
        metadata?: Record<string, unknown>;
        variables: Record<string, unknown>;
      } = {
        workspaceId: body.workspaceId,
        agentId: body.agentId,
        fromNumber: body.fromNumber ?? '',
        toNumber: c.toNumber,
        variables: withDefaultVariables(c.variables),
      };
      if (body.agentPhoneNumberId) payload.agentPhoneNumberId = body.agentPhoneNumberId;
      if (c.metadata) payload.metadata = c.metadata;
      return { jobType: 'BULK' as const, payload };
    });

    await prisma.call.createMany({
      data: jobs.map((j) => ({
        workspaceId: j.payload.workspaceId,
        agentId: j.payload.agentId,
        to: j.payload.toNumber,
        from: j.payload.fromNumber,
        status: 'queued',
        priority: 0,
        metadata: (j.payload.metadata ?? null) as any,
      })),
    });

    const res = await addBulkCalls(jobs);
    return reply.code(202).send({ enqueued: res.length });
  });
}


