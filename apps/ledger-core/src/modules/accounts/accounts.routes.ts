import type { FastifyPluginAsync } from 'fastify';
import { AccountsController } from './accounts.controller';
import { AccountsRepository } from './accounts.repository';
import { AccountsService } from './accounts.service';
import {
  bootstrapAccountsSchema,
  bulkCreateAccountsSchema,
  createAccountSchema,
  getAccountBalanceSchema,
  getAccountByIdSchema,
  listAccountsSchema,
  lookupAccountSchema,
  updateAccountStatusSchema,
  type AccountParams,
  type BalanceQuery,
  type BootstrapAccountsInput,
  type BulkCreateAccountsInput,
  type CreateAccountInput,
  type ListAccountsQuery,
  type LookupAccountQuery,
  type TenantHeaders,
  type UpdateAccountStatusInput,
} from './accounts.schemas';

export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  const repository = new AccountsRepository(fastify.db);
  const service = new AccountsService(repository);
  const controller = new AccountsController(service);

  fastify.post<{ Body: CreateAccountInput; Headers: TenantHeaders }>(
    '/',
    { schema: createAccountSchema },
    controller.createAccount
  );

  fastify.post<{ Body: BulkCreateAccountsInput; Headers: TenantHeaders }>(
    '/bulk',
    { schema: bulkCreateAccountsSchema },
    controller.createAccountsBulk
  );

  fastify.post<{ Body: BootstrapAccountsInput; Headers: TenantHeaders }>(
    '/bootstrap',
    { schema: bootstrapAccountsSchema },
    controller.bootstrapSystemAccounts
  );

  fastify.get<{ Querystring: ListAccountsQuery; Headers: TenantHeaders }>(
    '/',
    { schema: listAccountsSchema },
    controller.listAccounts
  );

  fastify.get<{ Querystring: LookupAccountQuery; Headers: TenantHeaders }>(
    '/lookup',
    { schema: lookupAccountSchema },
    controller.lookupAccount
  );

  fastify.get<{ Params: AccountParams; Headers: TenantHeaders }>(
    '/:id',
    { schema: getAccountByIdSchema },
    controller.getAccountById
  );

  fastify.get<{ Params: AccountParams; Querystring: BalanceQuery; Headers: TenantHeaders }>(
    '/:id/balance',
    { schema: getAccountBalanceSchema },
    controller.getAccountBalance
  );

  fastify.patch<{ Params: AccountParams; Body: UpdateAccountStatusInput; Headers: TenantHeaders }>(
    '/:id/status',
    { schema: updateAccountStatusSchema },
    controller.updateAccountStatus
  );
};
