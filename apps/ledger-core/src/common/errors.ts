export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode = 400,
    errorCode = 'BAD_REQUEST',
    details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;

    // isOperational: true means an anticipated, safe business condition.
    // isOperational: false means an unhandled programmer bug or system crash.
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details?: unknown) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(
    message = 'Request cannot be processed due to business rule violation',
    errorCode = 'UNPROCESSABLE_ENTITY',
    details?: unknown
  ) {
    super(message, 422, errorCode, details);
  }
}

export class DoubleEntryImbalanceError extends AppError {
  constructor(message = 'Total debits must equal total credits', details?: unknown) {
    super(message, 422, 'DOUBLE_ENTRY_IMBALANCE', details);
  }
}

export class LedgerImmutabilityError extends AppError {
  constructor(message = 'Historical ledger entries cannot be altered or deleted', details?: unknown) {
    super(message, 403, 'LEDGER_IMMUTABLE', details);
  }
}

export class TransactionFinalizedError extends AppError {
  constructor(message = 'Completed or failed transactions cannot be modified', details?: unknown) {
    super(message, 409, 'TRANSACTION_FINALIZED', details);
  }
}
