import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceOwnerCategoryNamespace,
  parseStrictAsOfTimestamp,
} from '../helpers/accounts.validators';
import {
  mapRawBalanceRowToDomain,
  mapRawCteRowToCreationResult,
  toAccountBalanceResponse,
  toAccountItemResponse,
} from '../helpers/accounts.mappers';
import { AccountsService } from '../accounts.service';
import type { AccountsRepository, BulkAccountItem } from '../accounts.repository';
import type { AccountRecord, AccountWithBalanceResult } from '../accounts.types';
import {
  NotFoundError,
  UnprocessableEntityError,
  ValidationError,
} from '../../../common/errors';

describe('Stage 1: Accounts Module — Stateless Unit & Domain Logic Tests', () => {
  describe('1.1 Owner-Category Namespace Isolation (enforceOwnerCategoryNamespace)', () => {
    it('permits valid external owner_id with external categories', () => {
      assert.doesNotThrow(() => enforceOwnerCategoryNamespace('usr_123', 'USER_WALLET'));
      assert.doesNotThrow(() => enforceOwnerCategoryNamespace('merch_99', 'MERCHANT_PAYABLE'));
    });

    it('permits sys_ prefixed owner_id with system categories', () => {
      assert.doesNotThrow(() =>
        enforceOwnerCategoryNamespace('sys_platform_clearing', 'SYSTEM_CLEARING')
      );
      assert.doesNotThrow(() =>
        enforceOwnerCategoryNamespace('SYS_REVENUE', 'PLATFORM_REVENUE')
      );
      assert.doesNotThrow(() =>
        enforceOwnerCategoryNamespace('sys_settlement_transit', 'SETTLEMENT_TRANSIT')
      );
    });

    it('rejects sys_ prefix (case-insensitive) on external categories', () => {
      assert.throws(
        () => enforceOwnerCategoryNamespace('sys_hacker', 'USER_WALLET'),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes('reserved exclusively for system categories')
      );
      assert.throws(
        () => enforceOwnerCategoryNamespace('SyS_Spoof', 'MERCHANT_PAYABLE', 4),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.startsWith('Account at index 4: ')
      );
    });

    it('rejects non-sys_ owner_id on system categories', () => {
      assert.throws(
        () => enforceOwnerCategoryNamespace('usr_123', 'SYSTEM_CLEARING'),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes("requires an owner_id prefixed with 'sys_'")
      );
    });
  });

  describe('1.2 Temporal as_of Parser & V8 Calendar Rollover Guard (parseStrictAsOfTimestamp)', () => {
    it('parses valid UTC, leap-year Feb 29, and timezone-offset ISO-8601 timestamps', () => {
      const utcDate = parseStrictAsOfTimestamp('2026-02-28T14:30:00.000Z');
      assert.equal(utcDate.toISOString(), '2026-02-28T14:30:00.000Z');

      const leapDate = parseStrictAsOfTimestamp('2024-02-29T12:00:00.000Z');
      assert.equal(leapDate.toISOString(), '2024-02-29T12:00:00.000Z');

      const istDate = parseStrictAsOfTimestamp('2026-02-28T01:00:00+05:30');
      assert.equal(istDate.toISOString(), '2026-02-27T19:30:00.000Z');
    });

    it('blocks V8 silent calendar rollover for impossible dates (Feb 30, non-leap Feb 29, Apr 31)', () => {
      for (const impossibleIso of [
        '2026-02-30T00:00:00Z',
        '2026-02-30T10:00:00+05:30',
        '2025-02-29T12:00:00Z',
        '2026-04-31T08:00:00Z',
      ]) {
        assert.throws(
          () => parseStrictAsOfTimestamp(impossibleIso),
          (err: unknown) =>
            err instanceof ValidationError &&
            err.message.includes('Invalid calendar date'),
          `Expected ${impossibleIso} to be rejected as an invalid calendar date`
        );
      }
    });

    it('rejects malformed non-date strings', () => {
      assert.throws(
        () => parseStrictAsOfTimestamp('not-a-valid-timestamp'),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes('Invalid as_of timestamp')
      );
    });

    it('rejects timestamps in the future beyond 5s NTP clock-skew tolerance', () => {
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      assert.throws(
        () => parseStrictAsOfTimestamp(futureIso),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes('cannot be in the future')
      );
    });

    it('permits minor NTP clock skew within 5s window', () => {
      const slightSkewIso = new Date(Date.now() + 2_000).toISOString();
      assert.doesNotThrow(() => parseStrictAsOfTimestamp(slightSkewIso));
    });
  });

  describe('1.3 Domain Mappers & Accounting Polarity (accounts.mappers)', () => {
    const sampleDate = new Date('2026-05-01T12:00:00.000Z');

    it('converts Postgres BIGINT strings into safe JS Numbers and standardizes id field', () => {
      const domain = mapRawBalanceRowToDomain({
        id: '01968f00-0000-7000-8000-000000000001',
        tenant_id: 'tnt_default',
        owner_id: 'usr_1',
        category: 'USER_WALLET',
        currency: 'USD',
        status: 'ACTIVE',
        created_at: sampleDate.toISOString(),
        credits_total: '15000',
        debits_total: '4500',
        balance: '10500',
        entry_count: '3',
      });

      assert.equal(typeof domain.balance, 'number');
      assert.equal(domain.balance, 10500);
      assert.equal(domain.creditsTotal, 15000);
      assert.equal(domain.debitsTotal, 4500);
      assert.equal(domain.entryCount, 3);

      const response = toAccountBalanceResponse(domain, sampleDate);
      assert.equal(response.id, '01968f00-0000-7000-8000-000000000001');
      assert.equal(response.normal_balance, 'CREDIT');
      assert.equal(response.as_of, '2026-05-01T12:00:00.000Z');
    });

    it('assigns DEBIT normal_balance to Asset categories and CREDIT to Liability/Revenue categories', () => {
      const makeResult = (
        category: AccountRecord['category']
      ): AccountWithBalanceResult => ({
        account: {
          id: '01968f00-0000-7000-8000-000000000002',
          tenant_id: 'tnt_default',
          owner_id: 'sys_test',
          category,
          currency: 'INR',
          status: 'ACTIVE',
          created_at: sampleDate,
        },
        balance: 0,
        creditsTotal: 0,
        debitsTotal: 0,
        entryCount: 0,
      });

      assert.equal(toAccountBalanceResponse(makeResult('SYSTEM_CLEARING')).normal_balance, 'DEBIT');
      assert.equal(toAccountBalanceResponse(makeResult('SETTLEMENT_TRANSIT')).normal_balance, 'DEBIT');
      assert.equal(toAccountBalanceResponse(makeResult('USER_WALLET')).normal_balance, 'CREDIT');
      assert.equal(toAccountBalanceResponse(makeResult('MERCHANT_PAYABLE')).normal_balance, 'CREDIT');
      assert.equal(toAccountBalanceResponse(makeResult('PLATFORM_REVENUE')).normal_balance, 'CREDIT');
    });

    it('includes is_new only when explicitly provided to toAccountItemResponse', () => {
      const mapped = mapRawCteRowToCreationResult({
        id: '01968f00-0000-7000-8000-000000000003',
        tenant_id: 'tnt_default',
        owner_id: 'usr_9',
        category: 'USER_WALLET',
        currency: 'EUR',
        status: 'ACTIVE',
        created_at: sampleDate,
        is_new: true,
      });

      const getResp = toAccountItemResponse(mapped.account);
      assert.equal('is_new' in getResp, false);

      const postResp = toAccountItemResponse(mapped.account, mapped.isNew);
      assert.equal(postResp.is_new, true);
    });
  });

  describe('1.4 AccountsService Singleflight Coalescing, Pagination & Lifecycle State Machine', () => {
    const sampleDate = new Date('2026-05-01T12:00:00.000Z');

    it('defaults category to USER_WALLET in createAccount and enforces namespace', async () => {
      let capturedCategory = '';
      const fakeRepo = {
        create: async (
          tenantId: string,
          ownerId: string,
          currency: string,
          category: AccountRecord['category']
        ) => {
          capturedCategory = category;
          return {
            account: {
              id: '01968f00-0000-7000-8000-000000000010',
              tenant_id: tenantId,
              owner_id: ownerId,
              category,
              currency,
              status: 'ACTIVE' as const,
              created_at: sampleDate,
            },
            isNew: true,
          };
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);
      const res = await service.createAccount('tnt_default', {
        owner_id: 'usr_alice',
        currency: 'INR',
      });

      assert.equal(capturedCategory, 'USER_WALLET');
      assert.equal(res.isNew, true);
      assert.equal(res.account.is_new, true);
      assert.equal(res.account.category, 'USER_WALLET');
    });

    it('throws 404 NotFoundError when getAccountById or getAccountByNaturalKey finds no row', async () => {
      const fakeRepo = {
        findById: async () => null,
        findByNaturalKey: async () => null,
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);

      await assert.rejects(
        () => service.getAccountById('tnt_default', '01968f00-0000-7000-8000-000000000404'),
        (err: unknown) => err instanceof NotFoundError
      );
      await assert.rejects(
        () => service.getAccountByNaturalKey('tnt_default', 'usr_missing', 'USER_WALLET', 'INR'),
        (err: unknown) => err instanceof NotFoundError
      );
    });

    it('coalesces 20 concurrent live getAccountBalance calls into 1 DB query and cleans up in finally', async () => {
      let dbQueryCount = 0;
      const fakeRepo = {
        findWithBalanceById: async (tenantId: string, accountId: string) => {
          dbQueryCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          return {
            account: {
              id: accountId,
              tenant_id: tenantId,
              owner_id: 'usr_hot',
              category: 'USER_WALLET' as const,
              currency: 'USD' as const,
              status: 'ACTIVE' as const,
              created_at: sampleDate,
            },
            balance: 50000,
            creditsTotal: 50000,
            debitsTotal: 0,
            entryCount: 1,
          };
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);
      const accountId = '01968f00-0000-7000-8000-000000000099';

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.getAccountBalance('tnt_default', accountId)
        )
      );

      assert.equal(
        dbQueryCount,
        1,
        'Expected Singleflight to execute only 1 DB query for 20 concurrent callers'
      );
      for (const res of results) {
        assert.equal(res.balance, 50000);
      }

      await service.getAccountBalance('tnt_default', accountId);
      assert.equal(
        dbQueryCount,
        2,
        'Expected subsequent call after Singleflight completion to query fresh state'
      );

      const histRes = await service.getAccountBalance(
        'tnt_default',
        accountId,
        '2026-05-01T12:00:00.000Z'
      );
      assert.equal(histRes.as_of, '2026-05-01T12:00:00.000Z');
      assert.equal(dbQueryCount, 3);
    });

    it('cleans up Singleflight entry even when DB query rejects or throws 404 NotFoundError', async () => {
      let callCount = 0;
      const fakeRepo = {
        findWithBalanceById: async () => {
          callCount += 1;
          return null;
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);
      const missingId = '01968f00-0000-7000-8000-000000000404';

      await assert.rejects(
        () => service.getAccountBalance('tnt_default', missingId),
        (err: unknown) => err instanceof NotFoundError
      );

      await assert.rejects(
        () => service.getAccountBalance('tnt_default', missingId),
        (err: unknown) => err instanceof NotFoundError
      );
      assert.equal(callCount, 2);
    });

    it('deduplicates identical tuples inside createAccountsBulk and tallies created vs existing counts', async () => {
      let passedItemsCount = 0;
      const fakeRepo = {
        createBulk: async (tenantId: string, items: BulkAccountItem[]) => {
          passedItemsCount = items.length;
          return items.map((item, idx) => ({
            account: {
              id: `01968f00-0000-7000-8000-00000000000${idx + 1}`,
              tenant_id: tenantId,
              owner_id: item.owner_id,
              category: item.category,
              currency: item.currency,
              status: 'ACTIVE' as const,
              created_at: sampleDate,
            },
            isNew: idx === 0,
          }));
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);
      const response = await service.createAccountsBulk('tnt_default', [
        { owner_id: 'usr_dup', category: 'USER_WALLET', currency: 'USD' },
        { owner_id: 'usr_unique', category: 'MERCHANT_PAYABLE', currency: 'INR' },
        { owner_id: 'usr_dup', category: 'USER_WALLET', currency: 'USD' },
      ]);

      assert.equal(passedItemsCount, 2, 'Repository should only receive 2 unique items');
      assert.equal(response.summary.total_requested, 2);
      assert.equal(response.summary.created_count, 1);
      assert.equal(response.summary.existing_count, 1);
    });

    it('provisions all 3 platform system accounts in bootstrapSystemAccounts', async () => {
      let capturedItems: BulkAccountItem[] = [];
      const fakeRepo = {
        createBulk: async (tenantId: string, items: BulkAccountItem[]) => {
          capturedItems = items;
          return items.map((item, idx) => ({
            account: {
              id: `01968f00-0000-7000-8000-00000000001${idx}`,
              tenant_id: tenantId,
              owner_id: item.owner_id,
              category: item.category,
              currency: item.currency,
              status: 'ACTIVE' as const,
              created_at: sampleDate,
            },
            isNew: true,
          }));
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);
      const res = await service.bootstrapSystemAccounts('tnt_swiggy', 'INR');

      assert.equal(capturedItems.length, 3);
      assert.equal(res.summary.created_count, 3);
      assert.deepEqual(
        capturedItems.map((i) => i.category),
        ['SYSTEM_CLEARING', 'PLATFORM_REVENUE', 'SETTLEMENT_TRANSIT']
      );
    });

    it('implements limit + 1 keyset pagination lookahead in listAccounts (both has_more=true and final page)', async () => {
      let requestedLimit = 0;
      let rowsToReturn = 3;
      const fakeRepo = {
        listAccounts: async (params: { limit: number; tenantId: string }) => {
          requestedLimit = params.limit;
          return Array.from({ length: rowsToReturn }, (_, idx) => ({
            id: `01968f00-0000-7000-8000-00000000000${idx + 1}`,
            tenant_id: params.tenantId,
            owner_id: `usr_${idx + 1}`,
            category: 'USER_WALLET' as const,
            currency: 'INR' as const,
            status: 'ACTIVE' as const,
            created_at: sampleDate,
          }));
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);

      const page1 = await service.listAccounts({ tenantId: 'tnt_default', limit: 2 });
      assert.equal(requestedLimit, 3, 'Must ask repository for limit + 1 rows');
      assert.equal(page1.accounts.length, 2, 'Must slice response back to requested limit');
      assert.equal(page1.pagination.has_more, true);
      assert.equal(page1.pagination.next_cursor, '01968f00-0000-7000-8000-000000000002');

      rowsToReturn = 2;
      const page2 = await service.listAccounts({ tenantId: 'tnt_default', limit: 2 });
      assert.equal(page2.accounts.length, 2);
      assert.equal(page2.pagination.has_more, false);
      assert.equal(page2.pagination.next_cursor, null);
    });

    it('enforces Zero-Balance prerequisite and terminal CLOSED state in updateAccountStatus', async () => {
      let currentStatus: AccountRecord['status'] = 'ACTIVE';
      let currentBalance = 2500;
      let updateCalls = 0;

      const fakeRepo = {
        findWithBalanceById: async (tenantId: string, id: string) => ({
          account: {
            id,
            tenant_id: tenantId,
            owner_id: 'usr_lifecycle',
            category: 'USER_WALLET' as const,
            currency: 'INR' as const,
            status: currentStatus,
            created_at: sampleDate,
          },
          balance: currentBalance,
          creditsTotal: currentBalance,
          debitsTotal: 0,
          entryCount: 1,
        }),
        updateStatus: async (
          tenantId: string,
          id: string,
          targetStatus: AccountRecord['status']
        ) => {
          updateCalls += 1;
          currentStatus = targetStatus;
          return {
            id,
            tenant_id: tenantId,
            owner_id: 'usr_lifecycle',
            category: 'USER_WALLET' as const,
            currency: 'INR' as const,
            status: currentStatus,
            created_at: sampleDate,
          };
        },
      } as unknown as AccountsRepository;

      const service = new AccountsService(fakeRepo);
      const accId = '01968f00-0000-7000-8000-000000000077';

      await assert.rejects(
        () => service.updateAccountStatus('tnt_default', accId, 'CLOSED'),
        (err: unknown) =>
          err instanceof UnprocessableEntityError &&
          err.errorCode === 'ACCOUNT_NON_ZERO_BALANCE'
      );
      assert.equal(updateCalls, 0);

      const noopRes = await service.updateAccountStatus('tnt_default', accId, 'ACTIVE');
      assert.equal(noopRes.status, 'ACTIVE');
      assert.equal(updateCalls, 0);

      currentBalance = 0;
      const closedRes = await service.updateAccountStatus('tnt_default', accId, 'CLOSED');
      assert.equal(closedRes.status, 'CLOSED');
      assert.equal(updateCalls, 1);

      await assert.rejects(
        () => service.updateAccountStatus('tnt_default', accId, 'ACTIVE'),
        (err: unknown) =>
          err instanceof UnprocessableEntityError &&
          err.errorCode === 'ACCOUNT_ALREADY_CLOSED'
      );
    });
  });
});
