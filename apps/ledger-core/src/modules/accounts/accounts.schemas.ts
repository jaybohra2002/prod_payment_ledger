import type { FastifySchema } from 'fastify';
import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  type AccountCategory,
  type AccountStatus,
} from '../../db/schema/index';
import { SUPPORTED_CURRENCIES } from '../../common/currencies';

export { ACCOUNT_CATEGORIES, ACCOUNT_STATUSES, type AccountCategory, type AccountStatus };

export interface CreateAccountInput {
  owner_id: string;
  currency: string;
  category?: AccountCategory;
}

export interface BulkCreateAccountsInput {
  accounts: CreateAccountInput[];
}

export interface BootstrapAccountsInput {
  currency?: string;
}

export interface LookupAccountQuery {
  owner_id: string;
  category?: AccountCategory;
  currency?: string;
  as_of?: string;
}

export interface ListAccountsQuery {
  owner_id?: string;
  category?: AccountCategory;
  currency?: string;
  status?: AccountStatus;
  limit?: number;
  cursor?: string;
}

export interface UpdateAccountStatusInput {
  status: AccountStatus;
}

export interface AccountParams {
  id: string;
}

export interface BalanceQuery {
  as_of?: string;
}

export interface TenantHeaders {
  'x-tenant-id'?: string;
}

const tenantHeadersSchema = {
  type: 'object',
  properties: {
    'x-tenant-id': {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[a-zA-Z0-9_-]+$',
    },
  },
} as const;

const accountIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      format: 'uuid',
    },
  },
} as const;

const ownerIdFieldSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  pattern: '^[a-zA-Z0-9_.:@-]+$',
} as const;

const currencyFieldSchema = {
  type: 'string',
  enum: [...SUPPORTED_CURRENCIES],
} as const;

const categoryFieldSchema = {
  type: 'string',
  enum: [...ACCOUNT_CATEGORIES],
} as const;

const statusFieldSchema = {
  type: 'string',
  enum: [...ACCOUNT_STATUSES],
} as const;

const asOfFieldSchema = {
  type: 'string',
  format: 'date-time',
} as const;

const responseMetaSchema = {
  type: 'object',
  required: ['request_id', 'timestamp'],
  properties: {
    request_id: { type: 'string' },
    timestamp: { type: 'string' },
  },
} as const;

const accountRecordDataSchema = {
  type: 'object',
  required: ['id', 'tenant_id', 'owner_id', 'category', 'currency', 'status', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenant_id: { type: 'string' },
    owner_id: { type: 'string' },
    category: categoryFieldSchema,
    currency: currencyFieldSchema,
    status: statusFieldSchema,
    created_at: { type: 'string' },
    is_new: { type: 'boolean' },
  },
} as const;

const singleAccountEnvelopeSchema = {
  type: 'object',
  required: ['success', 'data', 'meta'],
  properties: {
    success: { type: 'boolean' },
    data: accountRecordDataSchema,
    meta: responseMetaSchema,
  },
} as const;

const bulkAccountsEnvelopeSchema = {
  type: 'object',
  required: ['success', 'data', 'meta'],
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      required: ['summary', 'accounts'],
      properties: {
        summary: {
          type: 'object',
          required: ['total_requested', 'created_count', 'existing_count'],
          properties: {
            total_requested: { type: 'integer' },
            created_count: { type: 'integer' },
            existing_count: { type: 'integer' },
          },
        },
        accounts: {
          type: 'array',
          items: accountRecordDataSchema,
        },
      },
    },
    meta: responseMetaSchema,
  },
} as const;

const accountBalanceEnvelopeSchema = {
  type: 'object',
  required: ['success', 'data', 'meta'],
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      required: [
        'id',
        'tenant_id',
        'owner_id',
        'category',
        'currency',
        'status',
        'normal_balance',
        'balance',
        'credits_total',
        'debits_total',
        'entry_count',
        'as_of',
      ],
      properties: {
        id: { type: 'string', format: 'uuid' },
        tenant_id: { type: 'string' },
        owner_id: { type: 'string' },
        category: categoryFieldSchema,
        currency: currencyFieldSchema,
        status: statusFieldSchema,
        normal_balance: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
        balance: { type: 'integer' },
        credits_total: { type: 'integer' },
        debits_total: { type: 'integer' },
        entry_count: { type: 'integer' },
        as_of: { type: 'string' },
      },
    },
    meta: responseMetaSchema,
  },
} as const;

const listAccountsEnvelopeSchema = {
  type: 'object',
  required: ['success', 'data', 'meta'],
  properties: {
    success: { type: 'boolean' },
    data: {
      type: 'object',
      required: ['accounts', 'pagination'],
      properties: {
        accounts: {
          type: 'array',
          items: accountRecordDataSchema,
        },
        pagination: {
          type: 'object',
          required: ['limit', 'next_cursor', 'has_more'],
          properties: {
            limit: { type: 'integer' },
            next_cursor: { type: ['string', 'null'] },
            has_more: { type: 'boolean' },
          },
        },
      },
    },
    meta: responseMetaSchema,
  },
} as const;

export const createAccountSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  body: {
    type: 'object',
    required: ['owner_id', 'currency'],
    additionalProperties: false,
    properties: {
      owner_id: ownerIdFieldSchema,
      currency: currencyFieldSchema,
      category: categoryFieldSchema,
    },
  },
  response: {
    200: singleAccountEnvelopeSchema,
    201: singleAccountEnvelopeSchema,
  },
};

export const bulkCreateAccountsSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  body: {
    type: 'object',
    required: ['accounts'],
    additionalProperties: false,
    properties: {
      accounts: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: {
          type: 'object',
          required: ['owner_id', 'currency'],
          additionalProperties: false,
          properties: {
            owner_id: ownerIdFieldSchema,
            currency: currencyFieldSchema,
            category: categoryFieldSchema,
          },
        },
      },
    },
  },
  response: {
    200: bulkAccountsEnvelopeSchema,
    201: bulkAccountsEnvelopeSchema,
  },
};

export const bootstrapAccountsSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      currency: currencyFieldSchema,
    },
  },
  response: {
    200: bulkAccountsEnvelopeSchema,
    201: bulkAccountsEnvelopeSchema,
  },
};

export const lookupAccountSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  querystring: {
    type: 'object',
    required: ['owner_id'],
    additionalProperties: false,
    properties: {
      owner_id: ownerIdFieldSchema,
      category: categoryFieldSchema,
      currency: currencyFieldSchema,
      as_of: asOfFieldSchema,
    },
  },
  response: {
    200: accountBalanceEnvelopeSchema,
  },
};

export const getAccountByIdSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  params: accountIdParamsSchema,
  response: {
    200: singleAccountEnvelopeSchema,
  },
};

export const getAccountBalanceSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  params: accountIdParamsSchema,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      as_of: asOfFieldSchema,
    },
  },
  response: {
    200: accountBalanceEnvelopeSchema,
  },
};

export const listAccountsSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      owner_id: ownerIdFieldSchema,
      category: categoryFieldSchema,
      currency: currencyFieldSchema,
      status: statusFieldSchema,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      cursor: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: listAccountsEnvelopeSchema,
  },
};

export const updateAccountStatusSchema: FastifySchema = {
  headers: tenantHeadersSchema,
  params: accountIdParamsSchema,
  body: {
    type: 'object',
    required: ['status'],
    additionalProperties: false,
    properties: {
      status: statusFieldSchema,
    },
  },
  response: {
    200: singleAccountEnvelopeSchema,
  },
};
