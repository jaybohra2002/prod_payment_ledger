import { pgTable, varchar, timestamp, primaryKey } from 'drizzle-orm/pg-core';

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    tenant_id: varchar('tenant_id', { length: 100 }).default('tnt_default').notNull(),
    key: varchar('key', { length: 255 }).notNull(),
    request_hash: varchar('request_hash', { length: 255 }).notNull(),
    response_snapshot: varchar('response_snapshot', { length: 4096 }),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: 'pk_idempotency_tenant_key', columns: [table.tenant_id, table.key] }),
  ]
);
