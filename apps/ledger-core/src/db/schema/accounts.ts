import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { accountCategoryEnum, accountStatusEnum } from './enums';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id')
      .default(sql`uuidv7()`)
      .primaryKey(),
    tenant_id: varchar('tenant_id', { length: 100 }).default('tnt_default').notNull(),
    owner_id: varchar('owner_id', { length: 255 }).notNull(),
    category: accountCategoryEnum('category').default('USER_WALLET').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    status: accountStatusEnum('status').default('ACTIVE').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_accounts_tenant_owner_cat_curr').on(
      table.tenant_id,
      table.owner_id,
      table.category,
      table.currency
    ),
    uniqueIndex('uq_accounts_tenant_id').on(table.tenant_id, table.id),
  ]
);
