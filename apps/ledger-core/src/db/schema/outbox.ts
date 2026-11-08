import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { outboxStatusEnum } from './enums';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id')
      .default(sql`uuidv7()`)
      .primaryKey(),
    tenant_id: varchar('tenant_id', { length: 100 }).notNull(),
    aggregate_type: varchar('aggregate_type', { length: 50 }).notNull(),
    aggregate_id: uuid('aggregate_id').notNull(),
    event_type: varchar('event_type', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: outboxStatusEnum('status').default('PENDING').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    published_at: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [
    // composite index for the background outbox relay worker polling PENDING events
    index('idx_outbox_status_created').on(table.status, table.created_at),
    index('idx_outbox_tenant').on(table.tenant_id),
  ]
);
