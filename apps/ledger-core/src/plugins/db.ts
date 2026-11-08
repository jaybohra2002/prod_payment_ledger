import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../db/schema/index';
import { env } from '../config/env';

declare module 'fastify' {
  interface FastifyInstance {
    db: PostgresJsDatabase<typeof schema>;
    sql: postgres.Sql;
  }
}

const dbPluginAsync: FastifyPluginAsync = async (fastify) => {
  const databaseUrl = env.DATABASE_URL;

  fastify.log.info(
    {
      databaseUrl: databaseUrl.replace(/:[^:@]+@/, ':****@'),
      poolMax: env.DB_POOL_MAX,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
    },
    'Initializing PostgreSQL connection pool (UTC enforced)'
  );

  const sql = postgres(databaseUrl, {
    max: env.DB_POOL_MAX,
    idle_timeout: env.DB_IDLE_TIMEOUT_SEC,
    connect_timeout: env.DB_CONNECT_TIMEOUT_SEC,
    connection: {
      timezone: 'UTC',
      random_page_cost: '1.1',
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
      lock_timeout: env.DB_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: env.DB_IDLE_IN_TX_TIMEOUT_MS,
    },
    onnotice: (notice) => {
      fastify.log.debug({ notice: notice.message }, 'PostgreSQL NOTICE');
    },
  });

  const db = drizzle(sql, { schema });
  fastify.decorate('sql', sql);
  fastify.decorate('db', db);

  fastify.addHook('onClose', async (instance) => {
    instance.log.info('Draining PostgreSQL connection pool...');
    await instance.sql.end({ timeout: env.DB_DRAIN_TIMEOUT_SEC });
    instance.log.info('PostgreSQL connection pool drained cleanly.');
  });
};

export const dbPlugin = fp(dbPluginAsync, {
  name: 'db-plugin',
  fastify: '4.x',
});
