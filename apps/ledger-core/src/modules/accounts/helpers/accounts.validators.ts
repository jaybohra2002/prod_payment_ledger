import type { AccountCategory } from '../../../db/schema/index';
import {
  AS_OF_CLOCK_SKEW_TOLERANCE_MS,
  SYSTEM_CATEGORIES,
} from '../../../common/constants';
import { ValidationError } from '../../../common/errors';

export function enforceOwnerCategoryNamespace(
  ownerId: string,
  category: AccountCategory,
  itemIndex?: number
): void {
  const prefix = itemIndex !== undefined ? `Account at index ${itemIndex}: ` : '';
  const isSysPrefix = ownerId.toLowerCase().startsWith('sys_');
  const isSysCategory = SYSTEM_CATEGORIES.has(category);

  if (isSysPrefix && !isSysCategory) {
    throw new ValidationError(
      `${prefix}owner_id prefix 'sys_' is reserved exclusively for system categories (SYSTEM_CLEARING, PLATFORM_REVENUE, SETTLEMENT_TRANSIT).`
    );
  }

  if (!isSysPrefix && isSysCategory) {
    throw new ValidationError(
      `${prefix}System account category '${category}' requires an owner_id prefixed with 'sys_' (or use POST /v1/accounts/bootstrap).`
    );
  }
}

export function parseStrictAsOfTimestamp(asOfIso: string): Date {
  const parsed = new Date(asOfIso);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`Invalid as_of timestamp: '${asOfIso}'`);
  }

  // Prevent V8 Date silent rollover on invalid dates (e.g. 2026-02-30 -> 2026-03-02)
  const datePartMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(asOfIso);
  if (datePartMatch) {
    const [, yearStr, monthStr, dayStr] = datePartMatch;
    let offsetMs = 0;
    const tzMatch = /([+-])(\d{2}):(\d{2})$/.exec(asOfIso);
    if (tzMatch) {
      const sign = tzMatch[1] === '+' ? 1 : -1;
      offsetMs = sign * (Number(tzMatch[2]) * 60 + Number(tzMatch[3])) * 60_000;
    }
    const wallClockDate = new Date(parsed.getTime() + offsetMs);
    if (
      wallClockDate.getUTCFullYear() !== Number(yearStr) ||
      wallClockDate.getUTCMonth() + 1 !== Number(monthStr) ||
      wallClockDate.getUTCDate() !== Number(dayStr)
    ) {
      throw new ValidationError(`Invalid calendar date in as_of timestamp: '${asOfIso}'`);
    }
  }

  if (parsed.getTime() > Date.now() + AS_OF_CLOCK_SKEW_TOLERANCE_MS) {
    throw new ValidationError(`as_of timestamp cannot be in the future: '${asOfIso}'`);
  }

  return parsed;
}
