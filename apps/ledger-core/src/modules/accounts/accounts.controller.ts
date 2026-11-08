import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DEFAULT_ACCOUNT_CATEGORY,
  DEFAULT_CURRENCY,
  DEFAULT_TENANT_ID,
  TENANT_ID_HEADER,
} from '../../common/constants';
import { buildSuccessResponse } from '../../common/response';
import type { AccountsService } from './accounts.service';
import type {
  AccountParams,
  BalanceQuery,
  BootstrapAccountsInput,
  BulkCreateAccountsInput,
  CreateAccountInput,
  ListAccountsQuery,
  LookupAccountQuery,
  TenantHeaders,
  UpdateAccountStatusInput,
} from './accounts.schemas';

function resolveTenantId(headers: TenantHeaders): string {
  const raw = headers[TENANT_ID_HEADER];
  return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_TENANT_ID;
}

export class AccountsController {
  constructor(private readonly service: AccountsService) {}

  createAccount = async (
    request: FastifyRequest<{ Body: CreateAccountInput; Headers: TenantHeaders }>,
    reply: FastifyReply
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const result = await this.service.createAccount(tenantId, request.body);
    return reply.status(result.isNew ? 201 : 200).send(
      buildSuccessResponse(result.account, request.id)
    );
  };

  createAccountsBulk = async (
    request: FastifyRequest<{ Body: BulkCreateAccountsInput; Headers: TenantHeaders }>,
    reply: FastifyReply
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const result = await this.service.createAccountsBulk(tenantId, request.body.accounts);
    const statusCode = result.summary.created_count === 0 ? 200 : 201;
    return reply.status(statusCode).send(buildSuccessResponse(result, request.id));
  };

  bootstrapSystemAccounts = async (
    request: FastifyRequest<{ Body: BootstrapAccountsInput; Headers: TenantHeaders }>,
    reply: FastifyReply
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const result = await this.service.bootstrapSystemAccounts(
      tenantId,
      request.body?.currency ?? DEFAULT_CURRENCY
    );
    const statusCode = result.summary.created_count === 0 ? 200 : 201;
    return reply.status(statusCode).send(buildSuccessResponse(result, request.id));
  };

  listAccounts = async (
    request: FastifyRequest<{ Querystring: ListAccountsQuery; Headers: TenantHeaders }>
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const result = await this.service.listAccounts({
      tenantId,
      ownerId: request.query.owner_id,
      category: request.query.category,
      currency: request.query.currency,
      status: request.query.status,
      limit: request.query.limit,
      cursor: request.query.cursor,
    });
    return buildSuccessResponse(result, request.id);
  };

  lookupAccount = async (
    request: FastifyRequest<{ Querystring: LookupAccountQuery; Headers: TenantHeaders }>
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const balanceData = await this.service.getAccountBalanceByNaturalKey(
      tenantId,
      request.query.owner_id,
      request.query.category ?? DEFAULT_ACCOUNT_CATEGORY,
      request.query.currency ?? DEFAULT_CURRENCY,
      request.query.as_of
    );
    return buildSuccessResponse(balanceData, request.id);
  };

  getAccountById = async (
    request: FastifyRequest<{ Params: AccountParams; Headers: TenantHeaders }>
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const account = await this.service.getAccountById(tenantId, request.params.id);
    return buildSuccessResponse(account, request.id);
  };

  getAccountBalance = async (
    request: FastifyRequest<{ Params: AccountParams; Querystring: BalanceQuery; Headers: TenantHeaders }>
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const balanceData = await this.service.getAccountBalance(
      tenantId,
      request.params.id,
      request.query.as_of
    );
    return buildSuccessResponse(balanceData, request.id);
  };

  updateAccountStatus = async (
    request: FastifyRequest<{ Params: AccountParams; Body: UpdateAccountStatusInput; Headers: TenantHeaders }>
  ) => {
    const tenantId = resolveTenantId(request.headers);
    const updated = await this.service.updateAccountStatus(
      tenantId,
      request.params.id,
      request.body.status
    );
    return buildSuccessResponse(updated, request.id);
  };
}
