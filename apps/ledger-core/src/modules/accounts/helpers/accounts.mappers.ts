import { NORMAL_DEBIT_CATEGORIES } from '../../../common/constants';
import type {
  AccountBalanceResponse,
  AccountCreationResult,
  AccountItemResponse,
  AccountRecord,
  AccountWithBalanceResult,
  RawAccountCteRow,
  RawAccountWithBalanceRow,
} from '../accounts.types';

export function mapRawCteRowToCreationResult(r: RawAccountCteRow): AccountCreationResult {
  return {
    account: {
      id: r.id,
      tenant_id: r.tenant_id,
      owner_id: r.owner_id,
      category: r.category,
      currency: r.currency,
      status: r.status,
      created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    },
    isNew: Boolean(r.is_new),
  };
}

export function mapRawBalanceRowToDomain(row: RawAccountWithBalanceRow): AccountWithBalanceResult {
  return {
    account: {
      id: row.id,
      tenant_id: row.tenant_id,
      owner_id: row.owner_id,
      category: row.category,
      currency: row.currency,
      status: row.status,
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    },
    balance: Number(row.balance),
    creditsTotal: Number(row.credits_total),
    debitsTotal: Number(row.debits_total),
    entryCount: Number(row.entry_count),
  };
}

export function toAccountItemResponse(
  account: AccountRecord,
  isNew?: boolean
): AccountItemResponse {
  return {
    id: account.id,
    tenant_id: account.tenant_id,
    owner_id: account.owner_id,
    category: account.category,
    currency: account.currency,
    status: account.status,
    created_at: account.created_at.toISOString(),
    ...(isNew !== undefined ? { is_new: isNew } : {}),
  };
}

export function toAccountBalanceResponse(
  result: AccountWithBalanceResult,
  asOfDate?: Date
): AccountBalanceResponse {
  const normalBalance = NORMAL_DEBIT_CATEGORIES.has(result.account.category)
    ? 'DEBIT'
    : 'CREDIT';

  return {
    id: result.account.id,
    tenant_id: result.account.tenant_id,
    owner_id: result.account.owner_id,
    category: result.account.category,
    currency: result.account.currency,
    status: result.account.status,
    normal_balance: normalBalance,
    balance: result.balance,
    credits_total: result.creditsTotal,
    debits_total: result.debitsTotal,
    entry_count: result.entryCount,
    as_of: (asOfDate ?? new Date()).toISOString(),
  };
}
