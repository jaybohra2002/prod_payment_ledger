import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { env } from './config/env';
import { REQUEST_ID_HEADER, SAFE_REQ_ID_REGEX } from './common/constants';
import { dbPlugin } from './plugins/db';
import { errorHandlerPlugin } from './plugins/error-handler';
import { lifecycleTracerPlugin } from './plugins/lifecycle-tracer';
import { accountRoutes } from './modules/accounts/accounts.routes';
import { buildSuccessResponse, buildErrorResponse } from './common/response';

export const buildServer = async (opts?: { logger?: boolean }) => {
  const enableLogger = opts?.logger ?? true;
  const fastify = Fastify({
    connectionTimeout: env.HTTP_CONNECTION_TIMEOUT_MS,
    requestTimeout: env.HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
    forceCloseConnections: 'idle',

    // Must be false so Fastify always runs genReqId instead of trusting unvalidated headers
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      if (typeof incoming === 'string' && SAFE_REQ_ID_REGEX.test(incoming)) {
        return incoming;
      }
      return crypto.randomUUID();
    },

    logger: !enableLogger
      ? false
      : env.IS_PRODUCTION
        ? { level: env.LOG_LEVEL }
        : {
            level: env.LOG_LEVEL,
            transport: {
              target: 'pino-pretty',
            },
          },
    disableRequestLogging: !enableLogger,
  });

  fastify.addHook('onSend', (request, reply, payload, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done(null, payload);
  });

  if (env.LOG_LIFECYCLE_TRACE) {
    await fastify.register(lifecycleTracerPlugin);
  }

  await fastify.register(errorHandlerPlugin);
  await fastify.register(dbPlugin);

  fastify.get('/health/live', async (request) => {
    return buildSuccessResponse(
      {
        status: 'alive',
        service: 'ledger-core',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
      request.id
    );
  });

  const handleReadinessCheck = async (request: any, reply: any) => {
    try {
      await fastify.sql`SELECT 1`;
      return buildSuccessResponse(
        {
          status: 'ready',
          service: 'ledger-core',
          database: 'connected',
        },
        request.id
      );
    } catch (err) {
      request.log.error(err, 'Database readiness probe failed');
      return reply.status(503).send(
        buildErrorResponse(
          'DATABASE_UNAVAILABLE',
          'Database readiness probe failed. Service cannot accept traffic.',
          request.id
        )
      );
    }
  };

  fastify.get('/health/ready', handleReadinessCheck);
  fastify.get('/health', handleReadinessCheck);

  await fastify.register(accountRoutes, { prefix: '/v1/accounts' });

  return fastify;
};

const start = async () => {
  let server: Awaited<ReturnType<typeof buildServer>> | null = null;
  try {
    server = await buildServer();
    await server.listen({ port: env.LEDGER_CORE_PORT, host: env.LEDGER_CORE_HOST });

    const gracefulShutdown = async (signal: string) => {
      server?.log.info(`Received ${signal}. Initiating graceful shutdown...`);
      try {
        await server?.close();
        server?.log.info('Server closed cleanly. Process exiting.');
        process.exit(0);
      } catch (err) {
        server?.log.error(err, 'Error during graceful shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (err) {
    console.error('Fatal server boot error:', err);
    process.exit(1);
  }
};

// Skip port binding when imported by integration tests
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
