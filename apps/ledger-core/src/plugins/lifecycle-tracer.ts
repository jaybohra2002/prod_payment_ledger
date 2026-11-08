import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

// Opt-in request lifecycle tracer (LOG_LIFECYCLE_TRACE=true)
const lifecycleTracerPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRoute', (routeOptions) => {
    fastify.log.debug(
      { method: routeOptions.method, url: routeOptions.url, prefix: routeOptions.prefix },
      `[BOOT: onRoute] Compiled route into Radix Tree: ${routeOptions.method} ${routeOptions.url}`
    );
  });

  fastify.addHook('onReady', (done) => {
    fastify.log.debug(
      {
        serverVersion: fastify.version,
        decorators: {
          hasDbDecorator: Boolean(fastify.db),
          hasSqlDecorator: Boolean(fastify.sql),
        },
      },
      '[BOOT: onReady] Server ready! Fastify root instance inspection complete.'
    );
    done();
  });

  fastify.addHook('onRequest', (request, _reply, done) => {
    request.log.debug(
      { reqId: request.id, method: request.method, url: request.url },
      '[LIFECYCLE: 1/8 onRequest] Client socket connected. Timer started.'
    );
    done();
  });

  fastify.addHook('preParsing', (request, _reply, payload, done) => {
    request.log.debug(
      { reqId: request.id },
      '[LIFECYCLE: 2/8 preParsing] Ready to parse incoming request stream.'
    );
    done(null, payload);
  });

  fastify.addHook('preValidation', (request, _reply, done) => {
    request.log.debug(
      { reqId: request.id },
      '[LIFECYCLE: 3/8 preValidation] Payload parsed. Ready for schema validation.'
    );
    done();
  });

  fastify.addHook('preHandler', (request, _reply, done) => {
    request.log.debug(
      { reqId: request.id },
      '[LIFECYCLE: 4/8 preHandler] Schema passed. Entering business logic gate.'
    );
    done();
  });

  fastify.addHook('preSerialization', (request, _reply, payload, done) => {
    request.log.debug(
      { reqId: request.id },
      '[LIFECYCLE: 5/8 preSerialization] Route handler finished. Preparing JSON stringify.'
    );
    done(null, payload);
  });

  fastify.addHook('onSend', (request, reply, payload, done) => {
    request.log.debug(
      { reqId: request.id, statusCode: reply.statusCode },
      '[LIFECYCLE: 6/8 onSend] Response headers & body serialized. Sending to client.'
    );
    done(null, payload);
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    request.log.debug(
      { reqId: request.id, statusCode: reply.statusCode, responseTimeMs: reply.elapsedTime },
      '[LIFECYCLE: 7/8 onResponse] Response delivered to client. Request lifecycle closed.'
    );
    done();
  });

  fastify.addHook('onError', (request, _reply, error, done) => {
    request.log.warn(
      { reqId: request.id, errorName: error.name, errorMessage: error.message },
      '[LIFECYCLE: EXCEPTION onError] An error was thrown! Routing to error-handler.ts'
    );
    done();
  });
};

export const lifecycleTracerPlugin = fp(lifecycleTracerPluginAsync, {
  name: 'lifecycle-tracer-plugin',
  fastify: '4.x',
});
