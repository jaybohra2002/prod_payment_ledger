import { sql, type SQL } from 'drizzle-orm';
import type { AccountCategory } from '../../../db/schema/index';

function toPgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

export function buildCreateAccountCteSql(
  tenantId: string,
  ownerId: string,
  category: AccountCategory,
  currency: string
): SQL {
  return sql`
    WITH inserted AS (
      INSERT INTO accounts (tenant_id, owner_id, category, currency)
      VALUES (${tenantId}, ${ownerId}, ${category}::account_category, ${currency})
      ON CONFLICT (tenant_id, owner_id, category, currency) DO NOTHING
      RETURNING id, tenant_id, owner_id, category, currency, status, created_at, TRUE AS is_new
    )
    SELECT id, tenant_id, owner_id, category, currency, status, created_at, is_new
    FROM inserted
    UNION ALL
    SELECT a.id, a.tenant_id, a.owner_id, a.category, a.currency, a.status, a.created_at, FALSE AS is_new
    FROM accounts a
    WHERE a.tenant_id = ${tenantId}
      AND a.owner_id = ${ownerId}
      AND a.category = ${category}::account_category
      AND a.currency = ${currency}
      AND NOT EXISTS (SELECT 1 FROM inserted)
    LIMIT 1
  `;
}

export function buildBulkCreateAccountsCteSql(
  tenantId: string,
  ownerIds: string[],
  categories: string[],
  currencies: string[]
): SQL {
  const ownerIdsLiteral = toPgArrayLiteral(ownerIds);
  const categoriesLiteral = toPgArrayLiteral(categories);
  const currenciesLiteral = toPgArrayLiteral(currencies);

  return sql`
    WITH input_rows AS (
      SELECT DISTINCT
        ${tenantId}::varchar(100) AS tenant_id,
        u.owner_id,
        u.category::account_category AS category,
        u.currency
      FROM UNNEST(
        ${ownerIdsLiteral}::varchar(255)[],
        ${categoriesLiteral}::text[],
        ${currenciesLiteral}::varchar(3)[]
      ) AS u(owner_id, category, currency)
      ORDER BY u.owner_id, category, u.currency
    ),
    inserted AS (
      INSERT INTO accounts (tenant_id, owner_id, category, currency)
      SELECT tenant_id, owner_id, category, currency
      FROM input_rows
      ON CONFLICT (tenant_id, owner_id, category, currency) DO NOTHING
      RETURNING id, tenant_id, owner_id, category, currency, status, created_at, TRUE AS is_new
    )
    SELECT id, tenant_id, owner_id, category, currency, status, created_at, is_new
    FROM inserted
    UNION ALL
    SELECT a.id, a.tenant_id, a.owner_id, a.category, a.currency, a.status, a.created_at, FALSE AS is_new
    FROM accounts a
    INNER JOIN input_rows i
      ON a.tenant_id = i.tenant_id
     AND a.owner_id = i.owner_id
     AND a.category = i.category
     AND a.currency = i.currency
    WHERE NOT EXISTS (
      SELECT 1 FROM inserted ins WHERE ins.id = a.id
    )
  `;
}

export function buildAccountWithBalanceSql(whereClause: SQL, asOf?: Date): SQL {
  const asOfClause = asOf
    ? sql`AND le.created_at <= ${asOf.toISOString()}::timestamptz`
    : sql``;

  return sql`
    SELECT
      a.id,
      a.tenant_id,
      a.owner_id,
      a.category,
      a.currency,
      a.status,
      a.created_at,
      COALESCE(b.balance, 0)::bigint AS balance,
      COALESCE(b.credits_total, 0)::bigint AS credits_total,
      COALESCE(b.debits_total, 0)::bigint AS debits_total,
      COALESCE(b.entry_count, 0)::int AS entry_count
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT
        SUM(
          CASE
            WHEN le.entry_type = 'CREDIT' AND a.category IN ('USER_WALLET', 'MERCHANT_PAYABLE', 'PLATFORM_REVENUE') THEN le.amount
            WHEN le.entry_type = 'DEBIT'  AND a.category IN ('USER_WALLET', 'MERCHANT_PAYABLE', 'PLATFORM_REVENUE') THEN -le.amount
            WHEN le.entry_type = 'DEBIT'  AND a.category IN ('SYSTEM_CLEARING', 'SETTLEMENT_TRANSIT') THEN le.amount
            WHEN le.entry_type = 'CREDIT' AND a.category IN ('SYSTEM_CLEARING', 'SETTLEMENT_TRANSIT') THEN -le.amount
            ELSE 0
          END
        ) AS balance,
        SUM(le.amount) FILTER (WHERE le.entry_type = 'CREDIT') AS credits_total,
        SUM(le.amount) FILTER (WHERE le.entry_type = 'DEBIT')  AS debits_total,
        COUNT(*) AS entry_count
      FROM ledger_entries le
      WHERE le.tenant_id = a.tenant_id
        AND le.account_id = a.id
        ${asOfClause}
    ) b ON TRUE
    WHERE ${whereClause}
    LIMIT 1
  `;
}
