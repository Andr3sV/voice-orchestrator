import Fastify from 'fastify';
import { registerCallsRoutes } from './routes/calls.routes.js';
import { logger } from './lib/logger.js';
import { env } from './lib/env.js';
import { redis } from './lib/redis.js';
import './queues/calls.worker.js';
import './queues/maintenance.worker.js';
import { scheduleDailyAggregationIfNeeded } from './queues/maintenance.queue.js';

async function main() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  await registerCallsRoutes(app);

  const port = Number(env.SERVICE_PORT ?? 3000);

  // Do not force connect; BullMQ and ioredis will connect lazily when needed
  await app.listen({ port, host: '0.0.0.0' });

  // Ensure daily maintenance job exists
  await scheduleDailyAggregationIfNeeded();
}

main().catch((err) => {
  logger.error(err, 'Server failed to start');
  process.exit(1);
});


