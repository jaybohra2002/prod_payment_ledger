import { pgTable, uuid, bigint, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { entryTypeEnum } from './enums';
import { transactions } from './transactions';
import { accounts } from './accounts';

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id')
      .default(sql`uuidv7()`)
      .primaryKey(),

    tenant_id: varchar('tenant_id', { length: 100 }).default('tnt_default').notNull(),

    transaction_id: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),

    account_id: uuid('account_id')
      .notNull()
      .references(() => accounts.id),

    amount: bigint('amount', { mode: 'number' }).notNull(),

    entry_type: entryTypeEnum('entry_type').notNull(),

    currency: varchar('currency', { length: 3 }).notNull(),

    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Migration 0005 appends INCLUDE (entry_type, amount) for index-only balance scans
    index('idx_ledger_entries_tenant_account').on(table.tenant_id, table.account_id, table.created_at),
    index('idx_ledger_entries_tx').on(table.transaction_id),
  ]
);
