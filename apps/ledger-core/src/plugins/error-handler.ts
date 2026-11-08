import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyError } from 'fastify';
import { AppError } from '../common/errors';
import { buildErrorResponse } from '../common/response';

const SQLSTATE_MAP: Record<string, { status: number; errorCode: string; defaultMessage: string }> = {
  '23505': {
    status: 409,
    errorCode: 'DUPLICATE_RESOURCE',
    defaultMessage: 'A resource with this unique identifier already exists.',
  },
  '23503': {
    status: 404,
    errorCode: 'REFERENCED_ENTITY_NOT_FOUND',
    defaultMessage: 'The referenced account or transaction does not exist.',
  },
  '23514': {
    status: 422,
    errorCode: 'CHECK_CONSTRAINT_VIOLATION',
    defaultMessage: 'The provided data violates a database integrity constraint.',
  },
  '40001': {
    status: 503,
    errorCode: 'CONCURRENCY_CONFLICT',
    defaultMessage: 'The transaction encountered a concurrency conflict. Please retry.',
  },
  '40P01': {
    status: 503,
    errorCode: 'DEADLOCK_DETECTED',
    defaultMessage: 'A database deadlock occurred. Please retry the transaction.',
  },
  '55P03': {
    status: 503,
    errorCode: 'LOCK_NOT_AVAILABLE',
    defaultMessage: 'The target resource is currently locked by another transaction. Please retry.',
  },
  '57014': {
    status: 504,
    errorCode: 'QUERY_TIMEOUT',
    defaultMessage: 'Database query exceeded the maximum allowed execution time.',
  },
  '08006': {
    status: 503,
    errorCode: 'DATABASE_UNAVAILABLE',
    defaultMessage: 'Unable to communicate with the database server.',
  },
};

const errorHandlerPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error: FastifyError & Record<string, any>, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected internal error occurred.';
    let details: unknown = undefined;

    const sqlCode = typeof error.code === 'string' ? error.code : undefined;
    const mapped = sqlCode ? SQLSTATE_MAP[sqlCode] : undefined;

    if (error instanceof AppError) {
      status = error.statusCode;
      code = error.errorCode;
      message = error.message;
      details = error.details;

      request.log.info({ code, message, details }, 'Handled operational domain error');
    } else if (error.validation) {
      status = 400;
      code = 'VALIDATION_ERROR';
      message = 'The request payload failed schema validation.';
      details = error.validation;

      request.log.warn({ details }, 'Request payload failed schema validation');
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode;
      code = error.code || 'BAD_REQUEST';
      message = error.message;

      request.log.warn({ code, message }, 'Fastify framework client request error');
    } else if (mapped) {
      status = mapped.status;
      code = mapped.errorCode;
      message = mapped.defaultMessage;

      request.log.warn(
        {
          sqlCode,
          routine: error.routine,
          table: error.table_name,
          constraint: error.constraint_name,
          rawMessage: error.message,
        },
        `Database constraint or timeout error: ${code}`
      );
    } else if (error.code === 'P0001') {
      const routine = String(error.routine || '');
      const rawMessage = String(error.message || '');
      status = 422;
      code = 'BUSINESS_RULE_VIOLATION';
      message = rawMessage;

      if (routine.includes('double_entry')) {
        code = 'DOUBLE_ENTRY_IMBALANCE';
      } else if (rawMessage.includes('Account closure violation')) {
        code = 'ACCOUNT_NON_ZERO_BALANCE';
        status = 422;
      } else if (rawMessage.includes('reopened')) {
        code = 'ACCOUNT_ALREADY_CLOSED';
        status = 422;
      } else if (routine.includes('immutability')) {
        code = 'LEDGER_IMMUTABILITY_VIOLATION';
        status = 403;
      } else if (routine.includes('lifecycle')) {
        code = 'TRANSACTION_LIFECYCLE_VIOLATION';
        status = 409;
      }

      request.log.warn({ routine, message: rawMessage }, `Financial trigger blocked operation: ${code}`);
    } else {
      request.log.error(error, 'Unhandled critical server error');
    }

    return reply.status(status).send(buildErrorResponse(code, message, request.id, details));
  });
};

export const errorHandlerPlugin = fp(errorHandlerPluginAsync, {
  name: 'error-handler-plugin',
  fastify: '4.x',
});
