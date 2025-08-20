import Fastify from 'fastify';
import { registerCallsRoutes } from './routes/calls.routes.js';
import fastifyWebsocket from '@fastify/websocket';
import { registerStreamsRoutes } from './routes/streams.routes.js';
import { logger } from './lib/logger.js';
import { env } from './lib/env.js';
import { redis } from './lib/redis.js';

async function main() {
  const app = Fastify({ logger: true });
  await app.register(fastifyWebsocket);

  app.get('/health', async () => ({ status: 'ok' }));

  await registerCallsRoutes(app);
  await registerStreamsRoutes(app);

  const port = Number(env.SERVICE_PORT ?? 3000);

  // Do not force connect; BullMQ and ioredis will connect lazily when needed
  await app.listen({ port, host: '0.0.0.0' });

  // Optionally disable workers for local tests
  if (process.env.DISABLE_WORKERS !== '1') {
    await import('./queues/calls.worker.js');
    await import('./queues/maintenance.worker.js');
    const { scheduleDailyAggregationIfNeeded } = await import('./queues/maintenance.queue.js');
    await scheduleDailyAggregationIfNeeded();
  } else {
    logger.info('Workers disabled by DISABLE_WORKERS=1');
  }
}

main().catch((err) => {
  logger.error(err, 'Server failed to start');
  process.exit(1);
});


