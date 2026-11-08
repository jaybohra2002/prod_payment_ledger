import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../../../index';

describe('Stage 2: Accounts Module — HTTP Contract & Real-PostgreSQL 18 Integration Tests', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const TEST_TENANT = `tnt_stage2_${Date.now()}`;
  let aliceAccountId = '';
  let clearingAccountId = '';
  let merch1AccountId = '';
  let beforeFirstTxIso = '';

  before(async () => {
    app = await buildServer();
    await app.ready();
  });

  after(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('2.1 Health Probes & Distributed Tracing Correlation ID (x-request-id)', () => {
    it('GET /health/live returns 200 OK and echoes valid incoming x-request-id', async () => {
      const customReqId = 'req_trace_stage2_001';
      const res = await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': customReqId },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['x-request-id'], customReqId);
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'alive');
      assert.equal(body.meta.request_id, customReqId);
    });

    it('GET /health/ready verifies Postgres 18 pool and sanitizes malicious x-request-id headers', async () => {
      const maliciousReqId = 'evil_id\r\nInjected-Header: hacked<script>';
      const res = await app.inject({
        method: 'GET',
        url: '/health/ready',
        headers: { 'x-request-id': maliciousReqId },
      });

      assert.equal(res.statusCode, 200);
      const echoedId = res.headers['x-request-id'] as string;
      assert.notEqual(echoedId, maliciousReqId, 'Malicious x-request-id must be rejected');
      assert.match(
        echoedId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        'Fallback request ID must be a clean UUIDv4'
      );
      const body = res.json();
      assert.equal(body.data.status, 'ready');
      assert.equal(body.data.database, 'connected');
    });
  });

  describe('2.2 Single Account Creation (POST /v1/accounts) & Idempotent Replay', () => {
    it('creates a new account (201 Created) with native Postgres 18 UUIDv7 and UTC TIMESTAMPTZ', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: {
          owner_id: 'usr_alice',
          currency: 'INR',
        },
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.tenant_id, TEST_TENANT);
      assert.equal(body.data.owner_id, 'usr_alice');
      assert.equal(body.data.category, 'USER_WALLET');
      assert.equal(body.data.currency, 'INR');
      assert.equal(body.data.status, 'ACTIVE');
      assert.equal(body.data.is_new, true);

      assert.match(
        body.data.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        'Expected PostgreSQL 18 native UUIDv7 identifier'
      );
      assert.ok(body.data.created_at.endsWith('Z'), 'Expected UTC ISO-8601 timestamp');

      aliceAccountId = body.data.id;
    });

    it('returns 200 OK with is_new=false and identical UUIDv7 on duplicate POST /v1/accounts', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: {
          owner_id: 'usr_alice',
          category: 'USER_WALLET',
          currency: 'INR',
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.id, aliceAccountId);
      assert.equal(body.data.is_new, false);
    });
  });

  describe('2.3 Fastify AJV Schema Guards & Namespace Isolation (400 Bad Request)', () => {
    it('rejects unsupported or lowercase currencies at AJV preValidation boundary', async () => {
      for (const badCurrency of ['XYZ', 'inr', 'USDT', '']) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/accounts',
          headers: { 'x-tenant-id': TEST_TENANT },
          payload: { owner_id: 'usr_bob', currency: badCurrency },
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error.code, 'VALIDATION_ERROR');
      }
    });

    it('rejects sys_ namespace spoofing on external categories and non-sys_ on system categories', async () => {
      const spoofSys = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: {
          owner_id: 'sys_attacker',
          category: 'USER_WALLET',
          currency: 'INR',
        },
      });
      assert.equal(spoofSys.statusCode, 400);
      assert.equal(spoofSys.json().error.code, 'VALIDATION_ERROR');

      const spoofInternal = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: {
          owner_id: 'usr_attacker',
          category: 'SYSTEM_CLEARING',
          currency: 'INR',
        },
      });
      assert.equal(spoofInternal.statusCode, 400);
      assert.equal(spoofInternal.json().error.code, 'VALIDATION_ERROR');
    });
  });

  describe('2.4 System Bootstrap (/bootstrap) & UNNEST Bulk Onboarding (/bulk)', () => {
    it('provisions all 3 system accounts on POST /v1/accounts/bootstrap (201) and replays idempotently (200)', async () => {
      const firstRun = await app.inject({
        method: 'POST',
        url: '/v1/accounts/bootstrap',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { currency: 'INR' },
      });

      assert.equal(firstRun.statusCode, 201);
      const firstBody = firstRun.json();
      assert.deepEqual(firstBody.data.summary, {
        total_requested: 3,
        created_count: 3,
        existing_count: 0,
      });

      const clearingAcc = firstBody.data.accounts.find(
        (a: { category: string }) => a.category === 'SYSTEM_CLEARING'
      );
      assert.ok(clearingAcc);
      clearingAccountId = clearingAcc.id;

      const secondRun = await app.inject({
        method: 'POST',
        url: '/v1/accounts/bootstrap',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { currency: 'INR' },
      });
      assert.equal(secondRun.statusCode, 200);
      assert.deepEqual(secondRun.json().data.summary, {
        total_requested: 3,
        created_count: 0,
        existing_count: 3,
      });
    });

    it('ingests mixed new and existing accounts in 1 UNNEST query via POST /v1/accounts/bulk', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/accounts/bulk',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: {
          accounts: [
            { owner_id: 'usr_alice', category: 'USER_WALLET', currency: 'INR' },
            { owner_id: 'merch_truffles', category: 'MERCHANT_PAYABLE', currency: 'INR' },
            { owner_id: 'merch_meghana', category: 'MERCHANT_PAYABLE', currency: 'INR' },
          ],
        },
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.deepEqual(body.data.summary, {
        total_requested: 3,
        created_count: 2,
        existing_count: 1,
      });

      const merch1 = body.data.accounts.find(
        (a: { owner_id: string }) => a.owner_id === 'merch_truffles'
      );
      assert.ok(merch1);
      merch1AccountId = merch1.id;
    });
  });

  describe('2.5 Point Lookups (GET /:id), Tenant Isolation & Keyset Pagination (GET /)', () => {
    it('fetches account by ID for owning tenant and blocks cross-tenant access with 404', async () => {
      const ownRes = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${aliceAccountId}`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(ownRes.statusCode, 200);
      const ownBody = ownRes.json();
      assert.equal(ownBody.data.id, aliceAccountId);
      assert.equal('is_new' in ownBody.data, false, 'GET /:id must omit is_new');

      const crossTenantRes = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${aliceAccountId}`,
        headers: { 'x-tenant-id': 'tnt_unauthorized_rival' },
      });
      assert.equal(crossTenantRes.statusCode, 404);
      assert.equal(crossTenantRes.json().error.code, 'NOT_FOUND');
    });

    it('paginates chronologically through tenant accounts using UUIDv7 keyset cursors', async () => {
      const page1 = await app.inject({
        method: 'GET',
        url: '/v1/accounts?limit=4',
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(page1.statusCode, 200);
      const body1 = page1.json();
      assert.equal(body1.data.accounts.length, 4);
      assert.equal(body1.data.pagination.has_more, true);
      assert.ok(body1.data.pagination.next_cursor);

      const page2 = await app.inject({
        method: 'GET',
        url: `/v1/accounts?limit=4&cursor=${body1.data.pagination.next_cursor}`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(page2.statusCode, 200);
      const body2 = page2.json();
      assert.equal(body2.data.accounts.length, 2);
      assert.equal(body2.data.pagination.has_more, false);
      assert.equal(body2.data.pagination.next_cursor, null);

      const allIds = [
        ...body1.data.accounts.map((a: { id: string }) => a.id),
        ...body2.data.accounts.map((a: { id: string }) => a.id),
      ];
      assert.equal(new Set(allIds).size, 6);
      const sortedIds = [...allIds].sort();
      assert.deepEqual(allIds, sortedIds, 'UUIDv7 keyset pagination must be strictly ordered');
    });
  });

  describe('2.6 Live Balance, Natural-Key /lookup & Historical as_of Time-Travel', () => {
    it('returns 0 balance for a newly created account', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${aliceAccountId}/balance`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });

      assert.equal(res.statusCode, 200);
      const data = res.json().data;
      assert.equal(data.id, aliceAccountId);
      assert.equal(data.normal_balance, 'CREDIT');
      assert.equal(data.balance, 0);
      assert.equal(data.credits_total, 0);
      assert.equal(data.debits_total, 0);
      assert.equal(data.entry_count, 0);
    });

    it('computes exact CREDIT/DEBIT polarity balances and supports historical as_of time-travel', async () => {
      beforeFirstTxIso = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 20));

      await app.sql.begin(async (tx) => {
        const [tx1] = await tx`
          INSERT INTO transactions (tenant_id, idempotency_key, type, status)
          VALUES (${TEST_TENANT}, ${'idem_tx1_' + TEST_TENANT}, 'PAYMENT', 'PENDING')
          RETURNING id
        `;
        await tx`
          INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
          VALUES
            (${TEST_TENANT}, ${tx1!.id}, ${aliceAccountId}, 'CREDIT', 10000, 'INR'),
            (${TEST_TENANT}, ${tx1!.id}, ${clearingAccountId}, 'DEBIT', 10000, 'INR')
        `;
        await tx`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = ${tx1!.id}`;

        const [tx2] = await tx`
          INSERT INTO transactions (tenant_id, idempotency_key, type, status)
          VALUES (${TEST_TENANT}, ${'idem_tx2_' + TEST_TENANT}, 'PAYOUT', 'PENDING')
          RETURNING id
        `;
        await tx`
          INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
          VALUES
            (${TEST_TENANT}, ${tx2!.id}, ${aliceAccountId}, 'DEBIT', 3500, 'INR'),
            (${TEST_TENANT}, ${tx2!.id}, ${clearingAccountId}, 'CREDIT', 3500, 'INR')
        `;
        await tx`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = ${tx2!.id}`;
      });

      const aliceBalRes = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${aliceAccountId}/balance`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(aliceBalRes.statusCode, 200);
      const aliceBal = aliceBalRes.json().data;
      assert.equal(aliceBal.normal_balance, 'CREDIT');
      assert.equal(aliceBal.balance, 6500);
      assert.equal(aliceBal.credits_total, 10000);
      assert.equal(aliceBal.debits_total, 3500);
      assert.equal(aliceBal.entry_count, 2);

      const lookupRes = await app.inject({
        method: 'GET',
        url: '/v1/accounts/lookup?owner_id=usr_alice&category=USER_WALLET&currency=INR',
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(lookupRes.statusCode, 200);
      assert.equal(lookupRes.json().data.balance, 6500);

      const clearingBalRes = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${clearingAccountId}/balance`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(clearingBalRes.statusCode, 200);
      const clearingBal = clearingBalRes.json().data;
      assert.equal(clearingBal.normal_balance, 'DEBIT');
      assert.equal(clearingBal.balance, 6500);
      assert.equal(clearingBal.debits_total, 10000);
      assert.equal(clearingBal.credits_total, 3500);

      const histRes = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${aliceAccountId}/balance?as_of=${encodeURIComponent(beforeFirstTxIso)}`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      assert.equal(histRes.statusCode, 200);
      assert.equal(histRes.json().data.balance, 0);
      assert.equal(histRes.json().data.entry_count, 0);
    });
  });

  describe('2.7 Account Lifecycle (PATCH /:id/status) & Storage-Level Trigger Proofs', () => {
    it('blocks closing usr_alice while balance is non-zero (422 ACCOUNT_NON_ZERO_BALANCE)', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/accounts/${aliceAccountId}/status`,
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { status: 'CLOSED' },
      });

      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, 'ACCOUNT_NON_ZERO_BALANCE');
    });

    it('transitions zero-balance account ACTIVE -> FROZEN -> CLOSED and blocks reopening (422 ACCOUNT_ALREADY_CLOSED)', async () => {
      const freezeRes = await app.inject({
        method: 'PATCH',
        url: `/v1/accounts/${merch1AccountId}/status`,
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { status: 'FROZEN' },
      });
      assert.equal(freezeRes.statusCode, 200);
      assert.equal(freezeRes.json().data.status, 'FROZEN');

      const closeRes = await app.inject({
        method: 'PATCH',
        url: `/v1/accounts/${merch1AccountId}/status`,
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { status: 'CLOSED' },
      });
      assert.equal(closeRes.statusCode, 200);
      assert.equal(closeRes.json().data.status, 'CLOSED');

      const reopenRes = await app.inject({
        method: 'PATCH',
        url: `/v1/accounts/${merch1AccountId}/status`,
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { status: 'ACTIVE' },
      });
      assert.equal(reopenRes.statusCode, 422);
      assert.equal(reopenRes.json().error.code, 'ACCOUNT_ALREADY_CLOSED');
    });

    it('enforces PostgreSQL storage-level triggers against raw SQL DELETE, identity tamper, and posting to CLOSED accounts', async () => {
      await assert.rejects(
        async () => {
          await app.sql`DELETE FROM accounts WHERE id = ${aliceAccountId}`;
        },
        (err: Error) => err.message.includes('Immutable ledger violation: DELETE operations are strictly prohibited')
      );

      await assert.rejects(
        async () => {
          await app.sql`UPDATE accounts SET currency = 'USD' WHERE id = ${aliceAccountId}`;
        },
        (err: Error) => err.message.includes('Core account identity fields')
      );

      await assert.rejects(
        async () => {
          await app.sql`UPDATE accounts SET status = 'CLOSED' WHERE id = ${aliceAccountId}`;
        },
        (err: Error) => err.message.includes('Account closure violation: cannot close account')
      );

      await assert.rejects(
        async () => {
          await app.sql.begin(async (tx) => {
            const [txRow] = await tx`
              INSERT INTO transactions (tenant_id, idempotency_key, type, status)
              VALUES (${TEST_TENANT}, ${'idem_closed_test_' + TEST_TENANT}, 'PAYMENT', 'PENDING')
              RETURNING id
            `;
            await tx`
              INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
              VALUES (${TEST_TENANT}, ${txRow!.id}, ${merch1AccountId}, 'CREDIT', 500, 'INR')
            `;
          });
        },
        (err: Error) => err.message.includes('Account status violation: cannot post ledger entries to a CLOSED account')
      );
    });
  });
});
