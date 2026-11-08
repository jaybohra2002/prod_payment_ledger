import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../../db/schema/index';
import type { AccountCategory, AccountStatus } from '../../db/schema/index';
import { DEFAULT_ACCOUNT_CATEGORY } from '../../common/constants';
import {
  buildAccountWithBalanceSql,
  buildBulkCreateAccountsCteSql,
  buildCreateAccountCteSql,
} from './helpers/accounts.queries';
import {
  mapRawBalanceRowToDomain,
  mapRawCteRowToCreationResult,
} from './helpers/accounts.mappers';
import type {
  AccountCreationResult,
  AccountRecord,
  AccountWithBalanceResult,
  BulkAccountItem,
  ListAccountsFilter,
  RawAccountCteRow,
  RawAccountWithBalanceRow,
} from './accounts.types';

export type {
  AccountCreationResult,
  AccountRecord,
  AccountWithBalanceResult,
  BulkAccountItem,
  ListAccountsFilter,
} from './accounts.types';

export class AccountsRepository {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async create(
    tenantId: string,
    ownerId: string,
    currency: string,
    category: AccountCategory = DEFAULT_ACCOUNT_CATEGORY
  ): Promise<AccountCreationResult> {
    const query = buildCreateAccountCteSql(tenantId, ownerId, category, currency);
    const rows = await this.db.execute<RawAccountCteRow>(query);

    const row = rows[0];
    if (row) {
      return mapRawCteRowToCreationResult(row);
    }

    // Fallback for concurrent READ COMMITTED conflict where another tx committed mid-statement
    const existing = await this.findByNaturalKey(tenantId, ownerId, category, currency);
    if (!existing) {
      throw new Error('Failed to retrieve existing account after concurrent conflict.');
    }

    return { account: existing, isNew: false };
  }

  async findByNaturalKey(
    tenantId: string,
    ownerId: string,
    category: AccountCategory,
    currency: string
  ): Promise<AccountRecord | null> {
    const [found] = await this.db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.tenant_id, tenantId),
          eq(schema.accounts.owner_id, ownerId),
          eq(schema.accounts.category, category),
          eq(schema.accounts.currency, currency)
        )
      )
      .limit(1);

    return found ?? null;
  }

  async createBulk(
    tenantId: string,
    items: BulkAccountItem[]
  ): Promise<AccountCreationResult[]> {
    if (items.length === 0) return [];

    const len = items.length;
    const ownerIds = new Array<string>(len);
    const categories = new Array<string>(len);
    const currencies = new Array<string>(len);

    for (let i = 0; i < len; i++) {
      const item = items[i]!;
      ownerIds[i] = item.owner_id;
      categories[i] = item.category;
      currencies[i] = item.currency;
    }

    const query = buildBulkCreateAccountsCteSql(tenantId, ownerIds, categories, currencies);
    let rows = await this.db.execute<RawAccountCteRow>(query);

    // Retry once with a fresh snapshot if a concurrent transaction committed an overlapping row
    if (rows.length < len) {
      rows = await this.db.execute<RawAccountCteRow>(query);
    }

    return rows.map(mapRawCteRowToCreationResult);
  }

  async findById(tenantId: string, id: string): Promise<AccountRecord | null> {
    const [found] = await this.db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.tenant_id, tenantId),
          eq(schema.accounts.id, id)
        )
      )
      .limit(1);

    return found ?? null;
  }

  async findWithBalanceById(
    tenantId: string,
    id: string,
    asOf?: Date
  ): Promise<AccountWithBalanceResult | null> {
    return this.executeAccountWithBalanceQuery(
      sql`a.tenant_id = ${tenantId} AND a.id = ${id}`,
      asOf
    );
  }

  async findWithBalanceByNaturalKey(
    tenantId: string,
    ownerId: string,
    category: AccountCategory,
    currency: string,
    asOf?: Date
  ): Promise<AccountWithBalanceResult | null> {
    return this.executeAccountWithBalanceQuery(
      sql`a.tenant_id = ${tenantId} AND a.owner_id = ${ownerId} AND a.category = ${category}::account_category AND a.currency = ${currency}`,
      asOf
    );
  }

  async listAccounts(filter: ListAccountsFilter): Promise<AccountRecord[]> {
    const conditions = [eq(schema.accounts.tenant_id, filter.tenantId)];

    if (filter.ownerId) {
      conditions.push(eq(schema.accounts.owner_id, filter.ownerId));
    }
    if (filter.category) {
      conditions.push(eq(schema.accounts.category, filter.category));
    }
    if (filter.currency) {
      conditions.push(eq(schema.accounts.currency, filter.currency));
    }
    if (filter.status) {
      conditions.push(eq(schema.accounts.status, filter.status));
    }
    if (filter.cursorId) {
      conditions.push(gt(schema.accounts.id, filter.cursorId));
    }

    return this.db
      .select()
      .from(schema.accounts)
      .where(and(...conditions))
      .orderBy(asc(schema.accounts.id))
      .limit(filter.limit);
  }

  async updateStatus(
    tenantId: string,
    id: string,
    status: AccountStatus
  ): Promise<AccountRecord | null> {
    return this.db.transaction(async (tx) => {
      // Lock the account row first so any in-flight FOR SHARE ledger entry insert commits
      // before the UPDATE statement takes its READ COMMITTED snapshot.
      await tx.execute(
        sql`SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`
      );

      const [updated] = await tx
        .update(schema.accounts)
        .set({ status })
        .where(and(eq(schema.accounts.tenant_id, tenantId), eq(schema.accounts.id, id)))
        .returning();

      return updated ?? null;
    });
  }

  private async executeAccountWithBalanceQuery(
    whereClause: SQL,
    asOf?: Date
  ): Promise<AccountWithBalanceResult | null> {
    const query = buildAccountWithBalanceSql(whereClause, asOf);
    const rows = await this.db.execute<RawAccountWithBalanceRow>(query);
    const row = rows[0];
    return row ? mapRawBalanceRowToDomain(row) : null;
  }
}
