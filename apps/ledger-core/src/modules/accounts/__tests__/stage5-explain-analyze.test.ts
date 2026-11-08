import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_LEVEL = 'warn';

import { buildServer } from '../../../index';

describe('Stage 5: Accounts Module — PostgreSQL 18 EXPLAIN (ANALYZE, BUFFERS) Query Plan Profiler', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const TEST_TENANT = `tnt_stage5_${Date.now()}`;
  let targetAccountId = '';
  let clearingAccountId = '';
  let cursorAccountId = '';

  before(async () => {
    app = await buildServer({ logger: false });
    await app.ready();

    const boot = await app.inject({
      method: 'POST',
      url: '/v1/accounts/bootstrap',
      headers: { 'x-tenant-id': TEST_TENANT },
      payload: { currency: 'INR' },
    });
    clearingAccountId = boot
      .json()
      .data.accounts.find((a: { category: string }) => a.category === 'SYSTEM_CLEARING').id;

    // Seed 250 accounts in 1 UNNEST call so the accounts table spans multiple 8KB pages
    const bulkAccounts = Array.from({ length: 250 }, (_, i) => ({
      owner_id: `usr_explain_${i}`,
      category: 'USER_WALLET' as const,
      currency: 'INR',
    }));

    const bulkRes = await app.inject({
      method: 'POST',
      url: '/v1/accounts/bulk',
      headers: { 'x-tenant-id': TEST_TENANT },
      payload: { accounts: bulkAccounts },
    });
    const createdAccounts = bulkRes.json().data.accounts;
    targetAccountId = createdAccounts[0].id;
    cursorAccountId = createdAccounts[50].id;

    // Seed 150 transactions (300 ledger_entries rows) so ledger_entries spans multiple 8KB pages
    await app.sql.begin(async (tx) => {
      for (let i = 0; i < 150; i++) {
        const [txRow] = await tx`
          INSERT INTO transactions (tenant_id, idempotency_key, type, status)
          VALUES (${TEST_TENANT}, ${`idem_exp_${i}_${TEST_TENANT}`}, 'PAYMENT', 'PENDING')
          RETURNING id
        `;
        await tx`
          INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
          VALUES
            (${TEST_TENANT}, ${txRow!.id}, ${targetAccountId}, 'CREDIT', 500, 'INR'),
            (${TEST_TENANT}, ${txRow!.id}, ${clearingAccountId}, 'DEBIT', 500, 'INR')
        `;
        await tx`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = ${txRow!.id}`;
      }
    });

    // Update Visibility Map (all-visible bits) and planner statistics for Index-Only Scans
    await app.sql`VACUUM ANALYZE accounts, transactions, ledger_entries`;
  });

  after(async () => {
    if (app) {
      await app.close();
    }
  });

  it('5.1 Profiles Point Lookup by ID (uq_accounts_tenant_id) — Index Scan & < 1.5ms', async () => {
    const planRows = await app.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT id, tenant_id, owner_id, category, currency, status, created_at
      FROM accounts
      WHERE tenant_id = ${TEST_TENANT} AND id = ${targetAccountId}
      LIMIT 1
    `;

    const planText = planRows.map((r) => r['QUERY PLAN']).join('\n');
    console.log('\n--- [5.1 EXPLAIN: Point Lookup by ID] ---\n' + planText);

    assert.equal(planText.includes('Seq Scan'), false, 'Must not perform a Seq Scan');
    assert.equal(planText.includes('Index Scan'), true, 'Expected Index Scan on accounts');
  });

  it('5.2 Profiles Keyset Cursor Pagination (uq_accounts_tenant_id) — Index Scan & Zero Sort Step', async () => {
    const planRows = await app.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT id, tenant_id, owner_id, category, currency, status, created_at
      FROM accounts
      WHERE tenant_id = ${TEST_TENANT} AND id > ${cursorAccountId}
      ORDER BY id ASC
      LIMIT 21
    `;

    const planText = planRows.map((r) => r['QUERY PLAN']).join('\n');
    console.log('\n--- [5.2 EXPLAIN: UUIDv7 Keyset Cursor Pagination] ---\n' + planText);

    assert.equal(planText.includes('Seq Scan'), false, 'Must not perform a Seq Scan');
    assert.equal(planText.includes('Index Scan using uq_accounts_tenant_id'), true);
    assert.equal(planText.includes('Sort Key'), false, 'Must read in B-Tree order without an in-memory Sort');
  });

  it('5.3 Profiles Live Balance Query (LEFT JOIN LATERAL + Covering Index) — Index Only Scan & Heap Fetches: 0', async () => {
    const planRows = await app.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
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
      ) b ON TRUE
      WHERE a.tenant_id = ${TEST_TENANT} AND a.id = ${targetAccountId}
      LIMIT 1
    `;

    const planText = planRows.map((r) => r['QUERY PLAN']).join('\n');
    console.log('\n--- [5.3 EXPLAIN: Live Balance Query (Covering Index)] ---\n' + planText);

    assert.equal(
      planText.includes('Index Only Scan using idx_ledger_entries_tenant_account'),
      true,
      'Expected Index Only Scan using idx_ledger_entries_tenant_account'
    );
    assert.equal(
      planText.includes('Heap Fetches: 0'),
      true,
      'Expected Heap Fetches: 0 from INCLUDE (entry_type, amount) covering index'
    );
  });

  it('5.4 Profiles Natural-Key /lookup Balance Query (uq_accounts_tenant_owner_cat_curr + Index Only Scan)', async () => {
    const planRows = await app.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
      SELECT
        a.id,
        COALESCE(b.balance, 0)::bigint AS balance
      FROM accounts a
      LEFT JOIN LATERAL (
        SELECT
          SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE -le.amount END) AS balance
        FROM ledger_entries le
        WHERE le.tenant_id = a.tenant_id
          AND le.account_id = a.id
      ) b ON TRUE
      WHERE a.tenant_id = ${TEST_TENANT}
        AND a.owner_id = 'usr_explain_0'
        AND a.category = 'USER_WALLET'::account_category
        AND a.currency = 'INR'
      LIMIT 1
    `;

    const planText = planRows.map((r) => r['QUERY PLAN']).join('\n');
    console.log('\n--- [5.4 EXPLAIN: Natural-Key /lookup + Balance] ---\n' + planText);

    assert.equal(
      planText.includes('Index Scan using uq_accounts_tenant_owner_cat_curr'),
      true,
      'Expected Index Scan using uq_accounts_tenant_owner_cat_curr'
    );
    assert.equal(
      planText.includes('Index Only Scan using idx_ledger_entries_tenant_account'),
      true,
      'Expected Index Only Scan on ledger_entries'
    );
  });
});
