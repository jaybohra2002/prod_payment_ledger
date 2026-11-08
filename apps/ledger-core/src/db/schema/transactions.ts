import { pgTable, uuid, varchar, timestamp, jsonb, uniqueIndex, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { txStatusEnum, txTypeEnum } from './enums';

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id')
      .default(sql`uuidv7()`)
      .primaryKey(),

    tenant_id: varchar('tenant_id', { length: 100 }).default('tnt_default').notNull(),
    idempotency_key: varchar('idempotency_key', { length: 255 }).notNull(),

    type: txTypeEnum('type').default('PAYMENT').notNull(),

    status: txStatusEnum('status').default('PENDING').notNull(),
    parent_transaction_id: uuid('parent_transaction_id').references((): AnyPgColumn => transactions.id),
    metadata: jsonb('metadata'),

    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_transactions_tenant_idempotency').on(table.tenant_id, table.idempotency_key),
    index('idx_transactions_tenant_created').on(table.tenant_id, table.created_at),
  ]
);
