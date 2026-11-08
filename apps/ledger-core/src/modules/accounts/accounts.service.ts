import type {
  AccountsRepository,
  AccountRecord,
  BulkAccountItem,
} from './accounts.repository';
import type {
  CreateAccountInput,
  AccountCategory,
  AccountStatus,
} from './accounts.schemas';
import {
  DEFAULT_ACCOUNT_CATEGORY,
  DEFAULT_CURRENCY,
  DEFAULT_PAGE_LIMIT,
} from '../../common/constants';
import {
  NotFoundError,
  UnprocessableEntityError,
} from '../../common/errors';
import {
  toAccountBalanceResponse,
  toAccountItemResponse,
} from './helpers/accounts.mappers';
import {
  enforceOwnerCategoryNamespace,
  parseStrictAsOfTimestamp,
} from './helpers/accounts.validators';
import type {
  AccountBalanceResponse,
  AccountItemResponse,
  BulkAccountsResponse,
  ListAccountsResponse,
} from './accounts.types';

export type {
  AccountBalanceResponse,
  AccountItemResponse,
  BulkAccountsResponse,
  ListAccountsResponse,
} from './accounts.types';

export class AccountsService {
  // Coalesces concurrent live balance reads for the same hot account within the active DB query window
  private readonly inFlightBalances = new Map<string, Promise<AccountBalanceResponse>>();

  constructor(private readonly repository: AccountsRepository) {}

  async createAccount(
    tenantId: string,
    input: CreateAccountInput
  ): Promise<{ account: AccountItemResponse; isNew: boolean }> {
    const category = input.category ?? DEFAULT_ACCOUNT_CATEGORY;
    enforceOwnerCategoryNamespace(input.owner_id, category);

    const { account, isNew } = await this.repository.create(
      tenantId,
      input.owner_id,
      input.currency,
      category
    );

    return {
      account: toAccountItemResponse(account, isNew),
      isNew,
    };
  }

  async createAccountsBulk(
    tenantId: string,
    inputs: CreateAccountInput[],
    allowSystemNamespace = false
  ): Promise<BulkAccountsResponse> {
    const seenKeys = new Set<string>();
    const deduplicatedItems: BulkAccountItem[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i]!;
      const category = item.category ?? DEFAULT_ACCOUNT_CATEGORY;

      if (!allowSystemNamespace) {
        enforceOwnerCategoryNamespace(item.owner_id, category, i);
      }

      const key = `${item.owner_id}\0${category}\0${item.currency}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        deduplicatedItems.push({
          owner_id: item.owner_id,
          category,
          currency: item.currency,
        });
      }
    }

    const results = await this.repository.createBulk(tenantId, deduplicatedItems);

    let createdCount = 0;
    let existingCount = 0;

    const mappedAccounts = results.map((r) => {
      if (r.isNew) createdCount++;
      else existingCount++;

      return toAccountItemResponse(r.account, r.isNew);
    });

    return {
      summary: {
        total_requested: deduplicatedItems.length,
        created_count: createdCount,
        existing_count: existingCount,
      },
      accounts: mappedAccounts,
    };
  }

  async bootstrapSystemAccounts(
    tenantId: string,
    currency: string = DEFAULT_CURRENCY
  ): Promise<BulkAccountsResponse> {
    const systemAccounts: CreateAccountInput[] = [
      { owner_id: 'sys_upi_clearing', category: 'SYSTEM_CLEARING', currency },
      { owner_id: 'sys_platform_revenue', category: 'PLATFORM_REVENUE', currency },
      { owner_id: 'sys_settlement_transit', category: 'SETTLEMENT_TRANSIT', currency },
    ];

    return this.createAccountsBulk(tenantId, systemAccounts, true);
  }

  async getAccountById(tenantId: string, id: string): Promise<AccountItemResponse> {
    const account = await this.repository.findById(tenantId, id);

    if (!account) {
      throw new NotFoundError(`Account with id '${id}' does not exist.`);
    }

    return toAccountItemResponse(account);
  }

  async getAccountByNaturalKey(
    tenantId: string,
    ownerId: string,
    category: AccountCategory = DEFAULT_ACCOUNT_CATEGORY,
    currency: string = DEFAULT_CURRENCY
  ): Promise<AccountRecord> {
    const account = await this.repository.findByNaturalKey(
      tenantId,
      ownerId,
      category,
      currency
    );

    if (!account) {
      throw new NotFoundError(
        `Account for owner '${ownerId}' (${category}, ${currency}) does not exist.`
      );
    }

    return account;
  }

  async getAccountBalance(
    tenantId: string,
    id: string,
    asOfIso?: string
  ): Promise<AccountBalanceResponse> {
    if (asOfIso) {
      const asOfDate = parseStrictAsOfTimestamp(asOfIso);
      const result = await this.repository.findWithBalanceById(tenantId, id, asOfDate);
      if (!result) {
        throw new NotFoundError(`Account with id '${id}' does not exist.`);
      }
      return toAccountBalanceResponse(result, asOfDate);
    }

    const flightKey = `id:${tenantId}:${id}`;
    const existingFlight = this.inFlightBalances.get(flightKey);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = (async () => {
      const result = await this.repository.findWithBalanceById(tenantId, id);
      if (!result) {
        throw new NotFoundError(`Account with id '${id}' does not exist.`);
      }
      return toAccountBalanceResponse(result);
    })();

    this.inFlightBalances.set(flightKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightBalances.delete(flightKey);
    }
  }

  async getAccountBalanceByNaturalKey(
    tenantId: string,
    ownerId: string,
    category: AccountCategory = DEFAULT_ACCOUNT_CATEGORY,
    currency: string = DEFAULT_CURRENCY,
    asOfIso?: string
  ): Promise<AccountBalanceResponse> {
    if (asOfIso) {
      const asOfDate = parseStrictAsOfTimestamp(asOfIso);
      const result = await this.repository.findWithBalanceByNaturalKey(
        tenantId,
        ownerId,
        category,
        currency,
        asOfDate
      );
      if (!result) {
        throw new NotFoundError(
          `Account for owner '${ownerId}' (${category}, ${currency}) does not exist.`
        );
      }
      return toAccountBalanceResponse(result, asOfDate);
    }

    const flightKey = `nk:${tenantId}:${ownerId}:${category}:${currency}`;
    const existingFlight = this.inFlightBalances.get(flightKey);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = (async () => {
      const result = await this.repository.findWithBalanceByNaturalKey(
        tenantId,
        ownerId,
        category,
        currency
      );
      if (!result) {
        throw new NotFoundError(
          `Account for owner '${ownerId}' (${category}, ${currency}) does not exist.`
        );
      }
      return toAccountBalanceResponse(result);
    })();

    this.inFlightBalances.set(flightKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightBalances.delete(flightKey);
    }
  }

  async listAccounts(params: {
    tenantId: string;
    ownerId?: string | undefined;
    category?: AccountCategory | undefined;
    currency?: string | undefined;
    status?: AccountStatus | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<ListAccountsResponse> {
    const limit = params.limit ?? DEFAULT_PAGE_LIMIT;

    const rows = await this.repository.listAccounts({
      tenantId: params.tenantId,
      ownerId: params.ownerId,
      category: params.category,
      currency: params.currency,
      status: params.status,
      limit: limit + 1,
      cursorId: params.cursor,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      accounts: pageRows.map((r) => toAccountItemResponse(r)),
      pagination: {
        limit,
        next_cursor: hasMore && lastRow ? lastRow.id : null,
        has_more: hasMore,
      },
    };
  }

  async updateAccountStatus(
    tenantId: string,
    id: string,
    targetStatus: AccountStatus
  ): Promise<AccountItemResponse> {
    const current = await this.repository.findWithBalanceById(tenantId, id);
    if (!current) {
      throw new NotFoundError(`Account with id '${id}' does not exist.`);
    }

    if (current.account.status === 'CLOSED' && targetStatus !== 'CLOSED') {
      throw new UnprocessableEntityError(
        `Account '${id}' is CLOSED and cannot be reopened.`,
        'ACCOUNT_ALREADY_CLOSED'
      );
    }

    if (targetStatus === 'CLOSED' && current.balance !== 0) {
      throw new UnprocessableEntityError(
        `Cannot close account '${id}' while balance is non-zero (${current.balance} ${current.account.currency} minor units). Sweep or settle balance to 0 first.`,
        'ACCOUNT_NON_ZERO_BALANCE'
      );
    }

    if (current.account.status === targetStatus) {
      return toAccountItemResponse(current.account);
    }

    const updated = await this.repository.updateStatus(tenantId, id, targetStatus);
    if (!updated) {
      throw new NotFoundError(`Account with id '${id}' does not exist.`);
    }

    return toAccountItemResponse(updated);
  }
}
