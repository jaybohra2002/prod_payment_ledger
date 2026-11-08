import { pgTable, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenantEnvEnum } from './enums';

export const tenants = pgTable(
  'tenants',
  {
    id: varchar('id', { length: 100 })
      .default(sql`('tnt_' || uuidv7()::text)`)
      .primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    environment: tenantEnvEnum('environment').default('TEST').notNull(),
    api_key_hash: varchar('api_key_hash', { length: 64 }).notNull().unique(),
    webhook_url: varchar('webhook_url', { length: 512 }),
    payout_config: jsonb('payout_config'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_tenants_api_key_hash').on(table.api_key_hash),
  ]
);
