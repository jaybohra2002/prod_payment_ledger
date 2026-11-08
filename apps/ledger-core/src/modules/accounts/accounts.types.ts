import type * as schema from '../../db/schema/index';
import type { AccountCategory, AccountStatus } from '../../db/schema/index';

export type AccountRecord = typeof schema.accounts.$inferSelect;

export interface AccountWithBalanceResult {
  account: AccountRecord;
  balance: number;
  creditsTotal: number;
  debitsTotal: number;
  entryCount: number;
}

export interface BulkAccountItem {
  owner_id: string;
  category: AccountCategory;
  currency: string;
}

export interface AccountCreationResult {
  account: AccountRecord;
  isNew: boolean;
}

export interface ListAccountsFilter {
  tenantId: string;
  ownerId?: string | undefined;
  category?: AccountCategory | undefined;
  currency?: string | undefined;
  status?: AccountStatus | undefined;
  limit: number;
  cursorId?: string | undefined;
}

export type RawAccountCteRow = {
  id: string;
  tenant_id: string;
  owner_id: string;
  category: AccountCategory;
  currency: string;
  status: AccountStatus;
  created_at: Date | string;
  is_new: boolean;
};

export type RawAccountWithBalanceRow = {
  id: string;
  tenant_id: string;
  owner_id: string;
  category: AccountCategory;
  currency: string;
  status: AccountStatus;
  created_at: Date | string;
  balance: string | number;
  credits_total: string | number;
  debits_total: string | number;
  entry_count: string | number;
};

export interface AccountItemResponse {
  id: string;
  tenant_id: string;
  owner_id: string;
  category: AccountCategory;
  currency: string;
  status: AccountStatus;
  created_at: string;
  is_new?: boolean;
}

export interface AccountBalanceResponse {
  id: string;
  tenant_id: string;
  owner_id: string;
  category: AccountCategory;
  currency: string;
  status: AccountStatus;
  normal_balance: 'CREDIT' | 'DEBIT';
  balance: number;
  credits_total: number;
  debits_total: number;
  entry_count: number;
  as_of: string;
}

export interface BulkAccountsResponse {
  summary: {
    total_requested: number;
    created_count: number;
    existing_count: number;
  };
  accounts: AccountItemResponse[];
}

export interface ListAccountsResponse {
  accounts: AccountItemResponse[];
  pagination: {
    limit: number;
    next_cursor: string | null;
    has_more: boolean;
  };
}
