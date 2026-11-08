import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../../../index';

describe('Stage 3: Accounts Module — Concurrency & Race-Condition Stress Tests', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const TEST_TENANT = `tnt_stage3_${Date.now()}`;
  let clearingAccountId = '';

  before(async () => {
    app = await buildServer();
    await app.ready();

    const boot = await app.inject({
      method: 'POST',
      url: '/v1/accounts/bootstrap',
      headers: { 'x-tenant-id': TEST_TENANT },
      payload: { currency: 'INR' },
    });
    const clearing = boot
      .json()
      .data.accounts.find((a: { category: string }) => a.category === 'SYSTEM_CLEARING');
    clearingAccountId = clearing.id;
  });

  after(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('3.1 50-Way Simultaneous Idempotent Account Creation Race (READ COMMITTED Invisible Conflict)', () => {
    it('elects 1 creator (201) and 49 idempotent replays (200) with identical UUIDv7 and zero 500 errors', async () => {
      const concurrency = 50;

      const responses = await Promise.all(
        Array.from({ length: concurrency }, () =>
          app.inject({
            method: 'POST',
            url: '/v1/accounts',
            headers: { 'x-tenant-id': TEST_TENANT },
            payload: {
              owner_id: 'usr_concurrent_race_01',
              category: 'USER_WALLET',
              currency: 'INR',
            },
          })
        )
      );

      let created201Count = 0;
      let existing200Count = 0;
      const returnedIds = new Set<string>();

      for (const res of responses) {
        const body = res.json();
        if (res.statusCode === 201) {
          created201Count += 1;
          assert.equal(body.data.is_new, true);
        } else if (res.statusCode === 200) {
          existing200Count += 1;
          assert.equal(body.data.is_new, false);
        } else {
          assert.fail(`Unexpected status code ${res.statusCode}: ${res.body}`);
        }
        returnedIds.add(body.data.id);
      }

      assert.equal(created201Count, 1, 'Exactly 1 request must win the INSERT (201 Created)');
      assert.equal(existing200Count, 49, 'All 49 concurrent losers must resolve via fallback (200 OK)');
      assert.equal(returnedIds.size, 1, 'All 50 concurrent callers must receive the exact same account UUIDv7');
    });
  });

  describe('3.2 50-Way Distinct Account Burst Across 20-Connection Pool', () => {
    it('creates 50 distinct accounts concurrently without pool starvation or UUID collisions', async () => {
      const concurrency = 50;

      const responses = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          app.inject({
            method: 'POST',
            url: '/v1/accounts',
            headers: { 'x-tenant-id': TEST_TENANT },
            payload: {
              owner_id: `usr_burst_${i}`,
              category: 'USER_WALLET',
              currency: 'INR',
            },
          })
        )
      );

      const ids = new Set<string>();
      for (const res of responses) {
        assert.equal(res.statusCode, 201);
        ids.add(res.json().data.id);
      }

      assert.equal(ids.size, concurrency);
    });
  });

  describe('3.3 20-Way Concurrent Overlapping UNNEST Bulk Ingestion Race', () => {
    it('prevents deadlocks via deterministic ORDER BY and returns all 25 accounts to all 20 callers', async () => {
      const bulkAccounts = Array.from({ length: 25 }, (_, i) => ({
        owner_id: `merch_bulk_race_${i}`,
        category: 'MERCHANT_PAYABLE' as const,
        currency: 'INR',
      }));

      // Reverse half the payloads to prove SQL ORDER BY u.owner_id prevents lock-order deadlocks
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, callerIdx) =>
          app.inject({
            method: 'POST',
            url: '/v1/accounts/bulk',
            headers: { 'x-tenant-id': TEST_TENANT },
            payload: {
              accounts:
                callerIdx % 2 === 0 ? bulkAccounts : [...bulkAccounts].reverse(),
            },
          })
        )
      );

      for (const res of responses) {
        assert.ok(
          res.statusCode === 201 || res.statusCode === 200,
          `Expected 200/201 but got ${res.statusCode}: ${res.body}`
        );
        const body = res.json();
        assert.equal(body.data.accounts.length, 25, 'Every caller must receive all 25 accounts');
        assert.equal(body.data.summary.total_requested, 25);
      }
    });
  });

  describe('3.4 100-Way Hot-Account Balance Stampede (Singleflight + Index-Only Scan)', () => {
    it('serves 100 simultaneous balance reads on a hot account with 0 errors and exact balance', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { owner_id: 'usr_hot_wallet', category: 'USER_WALLET', currency: 'INR' },
      });
      const hotAccountId = createRes.json().data.id as string;

      await app.sql.begin(async (tx) => {
        const [txRow] = await tx`
          INSERT INTO transactions (tenant_id, idempotency_key, type, status)
          VALUES (${TEST_TENANT}, ${'idem_hot_' + TEST_TENANT}, 'PAYMENT', 'PENDING')
          RETURNING id
        `;
        await tx`
          INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
          VALUES
            (${TEST_TENANT}, ${txRow!.id}, ${hotAccountId}, 'CREDIT', 88000, 'INR'),
            (${TEST_TENANT}, ${txRow!.id}, ${clearingAccountId}, 'DEBIT', 88000, 'INR')
        `;
        await tx`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = ${txRow!.id}`;
      });

      const responses = await Promise.all(
        Array.from({ length: 100 }, () =>
          app.inject({
            method: 'GET',
            url: `/v1/accounts/${hotAccountId}/balance`,
            headers: { 'x-tenant-id': TEST_TENANT },
          })
        )
      );

      for (const res of responses) {
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().data.balance, 88000);
      }
    });
  });

  describe('3.5 Concurrent Account Closure vs. Concurrent Deposit Race (TOCTOU Guard)', () => {
    it('guarantees an account never ends up CLOSED with a non-zero balance under concurrent mutation', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/v1/accounts',
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { owner_id: 'usr_toctou_race', category: 'USER_WALLET', currency: 'INR' },
      });
      const raceAccountId = createRes.json().data.id as string;

      const closePromise = app.inject({
        method: 'PATCH',
        url: `/v1/accounts/${raceAccountId}/status`,
        headers: { 'x-tenant-id': TEST_TENANT },
        payload: { status: 'CLOSED' },
      });

      const depositPromise = (async () => {
        try {
          await app.sql.begin(async (tx) => {
            const [txRow] = await tx`
              INSERT INTO transactions (tenant_id, idempotency_key, type, status)
              VALUES (${TEST_TENANT}, ${'idem_toctou_' + TEST_TENANT}, 'PAYMENT', 'PENDING')
              RETURNING id
            `;
            await tx`
              INSERT INTO ledger_entries (tenant_id, transaction_id, account_id, entry_type, amount, currency)
              VALUES
                (${TEST_TENANT}, ${txRow!.id}, ${raceAccountId}, 'CREDIT', 5000, 'INR'),
                (${TEST_TENANT}, ${txRow!.id}, ${clearingAccountId}, 'DEBIT', 5000, 'INR')
            `;
            await tx`UPDATE transactions SET status = 'COMPLETED', completed_at = now() WHERE id = ${txRow!.id}`;
          });
          return 'DEPOSIT_COMMITTED';
        } catch {
          return 'DEPOSIT_REJECTED';
        }
      })();

      await Promise.all([closePromise, depositPromise]);

      const finalBalRes = await app.inject({
        method: 'GET',
        url: `/v1/accounts/${raceAccountId}/balance`,
        headers: { 'x-tenant-id': TEST_TENANT },
      });
      const finalState = finalBalRes.json().data;

      // Invariant: Either the deposit won (ACTIVE, balance=5000) OR closure won (CLOSED, balance=0).
      // It is impossible for the account to be CLOSED with balance=5000!
      const validOutcome =
        (finalState.status === 'CLOSED' && finalState.balance === 0) ||
        (finalState.status === 'ACTIVE' && finalState.balance === 5000);

      assert.equal(
        validOutcome,
        true,
        `Illegal TOCTOU state detected: status=${finalState.status}, balance=${finalState.balance}`
      );
    });
  });
});
