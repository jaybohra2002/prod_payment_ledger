import type { AccountCategory } from '../db/schema/index';

export const SAFE_REQ_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export const REQUEST_ID_HEADER = 'x-request-id';
export const TENANT_ID_HEADER = 'x-tenant-id';

export const DEFAULT_TENANT_ID = 'tnt_default';
export const DEFAULT_CURRENCY = 'INR';
export const DEFAULT_ACCOUNT_CATEGORY: AccountCategory = 'USER_WALLET';
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const AS_OF_CLOCK_SKEW_TOLERANCE_MS = 5_000;

export const SYSTEM_CATEGORIES: ReadonlySet<AccountCategory> = new Set<AccountCategory>([
  'SYSTEM_CLEARING',
  'PLATFORM_REVENUE',
  'SETTLEMENT_TRANSIT',
]);

// Asset/clearing accounts carry a DEBIT normal balance; liability/revenue accounts carry CREDIT
export const NORMAL_DEBIT_CATEGORIES: ReadonlySet<AccountCategory> = new Set<AccountCategory>([
  'SYSTEM_CLEARING',
  'SETTLEMENT_TRANSIT',
]);
