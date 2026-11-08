CREATE OR REPLACE FUNCTION enforce_double_entry_invariant()
RETURNS TRIGGER AS $$
DECLARE
  total_debits   BIGINT;
  total_credits  BIGINT;
  entry_count    INTEGER;
  currency_count INTEGER;
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status = 'PENDING' THEN

    -- 1. Must have at least 2 entries (debit leg + credit leg)
    SELECT COUNT(*) INTO entry_count
    FROM ledger_entries
    WHERE transaction_id = NEW.id;

    IF entry_count < 2 THEN
      RAISE EXCEPTION 'Double-entry invariant violation: transaction % has only % ledger entries (minimum 2 required)',
        NEW.id, entry_count;
    END IF;

    -- 2. Sum debits and credits
    SELECT COALESCE(SUM(amount), 0) INTO total_debits
    FROM ledger_entries
    WHERE transaction_id = NEW.id AND entry_type = 'DEBIT';

    SELECT COALESCE(SUM(amount), 0) INTO total_credits
    FROM ledger_entries
    WHERE transaction_id = NEW.id AND entry_type = 'CREDIT';

    -- 3. Invariant: SUM(Debits) MUST EQUAL SUM(Credits)
    IF total_debits != total_credits THEN
      RAISE EXCEPTION 'Double-entry invariant violation: transaction % debits (%) != credits (%)',
        NEW.id, total_debits, total_credits;
    END IF;

    -- 4. Positive amount invariant: transaction value cannot be zero
    IF total_debits <= 0 THEN
      RAISE EXCEPTION 'Double-entry invariant violation: transaction % total amount must be strictly greater than 0',
        NEW.id;
    END IF;

    -- 5. Currency consistency: all entries within transaction must have identical currency
    SELECT COUNT(DISTINCT currency) INTO currency_count
    FROM ledger_entries
    WHERE transaction_id = NEW.id;

    IF currency_count != 1 THEN
      RAISE EXCEPTION 'Multi-currency violation: transaction % contains % distinct currencies (must be exactly 1)',
        NEW.id, currency_count;
    END IF;

    -- 6. Stamp completion time if not explicitly provided
    NEW.completed_at = COALESCE(NEW.completed_at, CLOCK_TIMESTAMP());

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_enforce_double_entry ON transactions;
--> statement-breakpoint
CREATE TRIGGER trg_enforce_double_entry
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_double_entry_invariant();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_ledger_entries_immutability()
RETURNS TRIGGER AS $$
DECLARE
  parent_status tx_status;
  acc_currency  VARCHAR(3);
BEGIN
  -- RULE 1: UPDATE is strictly prohibited
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Immutable ledger violation: UPDATE operations are strictly prohibited on ledger_entries (id: %)',
      OLD.id;
  END IF;

  -- RULE 2: DELETE is strictly prohibited
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable ledger violation: DELETE operations are strictly prohibited on ledger_entries (id: %)',
      OLD.id;
  END IF;

  -- RULE 3: Validations on INSERT
  IF TG_OP = 'INSERT' THEN
    -- Amount must be strictly positive
    IF NEW.amount <= 0 THEN
      RAISE EXCEPTION 'Invalid ledger entry: amount (%) must be strictly greater than 0',
        NEW.amount;
    END IF;

    -- Verify parent transaction exists and is currently PENDING
    SELECT status INTO parent_status
    FROM transactions
    WHERE id = NEW.transaction_id;

    IF parent_status IS NULL THEN
      RAISE EXCEPTION 'Orphan ledger entry: parent transaction % does not exist',
        NEW.transaction_id;
    END IF;

    IF parent_status != 'PENDING' THEN
      RAISE EXCEPTION 'Transaction locked: cannot insert ledger entries into a transaction with status % (transaction_id: %)',
        parent_status, NEW.transaction_id;
    END IF;

    -- Verify currency matches target account currency
    SELECT currency INTO acc_currency
    FROM accounts
    WHERE id = NEW.account_id;

    IF acc_currency IS NULL THEN
      RAISE EXCEPTION 'Orphan ledger entry: target account % does not exist',
        NEW.account_id;
    END IF;

    IF acc_currency != NEW.currency THEN
      RAISE EXCEPTION 'Currency mismatch: entry currency (%) does not match account currency (%) for account %',
        NEW.currency, acc_currency, NEW.account_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ledger_entries_immutability ON ledger_entries;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_entries_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_ledger_entries_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_transactions_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  -- RULE 1: DELETE is strictly prohibited (Transactions are permanent audit logs)
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Audit trail violation: DELETE operations are strictly prohibited on transactions (id: %)',
      OLD.id;
  END IF;

  -- RULE 2: State machine on UPDATE
  IF TG_OP = 'UPDATE' THEN
    -- Terminal state check: COMPLETED transactions are frozen forever
    IF OLD.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'Terminal state violation: transaction % is COMPLETED and permanently immutable. Create a REFUND or ADJUSTMENT transaction instead.',
        OLD.id;
    END IF;

    -- Terminal state check: FAILED transactions cannot be revived
    IF OLD.status = 'FAILED' THEN
      RAISE EXCEPTION 'Terminal state violation: transaction % is FAILED and cannot be modified or resurrected.',
        OLD.id;
    END IF;

    -- Transitions from PENDING
    IF OLD.status = 'PENDING' THEN
      -- Can ONLY transition to COMPLETED or FAILED
      IF NEW.status NOT IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'Invalid state transition: transaction % cannot transition from PENDING to %',
          OLD.id, NEW.status;
      END IF;

      -- Tamper-proofing: immutable header columns cannot change during status transition
      IF NEW.id != OLD.id OR NEW.idempotency_key != OLD.idempotency_key OR NEW.type != OLD.type OR NEW.created_at != OLD.created_at THEN
        RAISE EXCEPTION 'Tamper violation: immutable columns (id, idempotency_key, type, created_at) cannot be modified on transaction %',
          OLD.id;
      END IF;

      IF OLD.parent_transaction_id IS DISTINCT FROM NEW.parent_transaction_id THEN
        RAISE EXCEPTION 'Tamper violation: parent_transaction_id cannot be modified on transaction %',
          OLD.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_transactions_lifecycle ON transactions;
--> statement-breakpoint
CREATE TRIGGER trg_transactions_lifecycle
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_transactions_lifecycle();