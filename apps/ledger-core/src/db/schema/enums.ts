import { pgEnum } from 'drizzle-orm/pg-core';

export const entryTypeEnum = pgEnum('entry_type', ['CREDIT', 'DEBIT']);
export const ENTRY_TYPES = entryTypeEnum.enumValues;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const txStatusEnum = pgEnum('tx_status', ['PENDING', 'COMPLETED', 'FAILED']);
export const TX_STATUSES = txStatusEnum.enumValues;
export type TxStatus = (typeof TX_STATUSES)[number];

export const txTypeEnum = pgEnum('tx_type', [
  'PAYMENT',
  'REFUND',
  'TRANSFER',
  'PAYOUT',
  'ADJUSTMENT',
]);
export const TX_TYPES = txTypeEnum.enumValues;
export type TxType = (typeof TX_TYPES)[number];

export const accountCategoryEnum = pgEnum('account_category', [
  'SYSTEM_CLEARING',
  'USER_WALLET',
  'MERCHANT_PAYABLE',
  'PLATFORM_REVENUE',
  'SETTLEMENT_TRANSIT',
]);
export const ACCOUNT_CATEGORIES = accountCategoryEnum.enumValues;
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

export const accountStatusEnum = pgEnum('account_status', [
  'ACTIVE',
  'FROZEN',
  'CLOSED',
]);
export const ACCOUNT_STATUSES = accountStatusEnum.enumValues;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const tenantEnvEnum = pgEnum('tenant_env', ['TEST', 'LIVE']);
export const TENANT_ENVS = tenantEnvEnum.enumValues;
export type TenantEnv = (typeof TENANT_ENVS)[number];

export const outboxStatusEnum = pgEnum('outbox_status', ['PENDING', 'PUBLISHED', 'FAILED']);
export const OUTBOX_STATUSES = outboxStatusEnum.enumValues;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
