CREATE TYPE "public"."account_status" AS ENUM('ACTIVE', 'FROZEN', 'CLOSED');--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "completed_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "published_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "status" "account_status" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_accounts_tenant_id" ON "accounts" USING btree ("tenant_id","id");--> statement-breakpoint

-- Covering index for index-only balance scans
DROP INDEX IF EXISTS "idx_ledger_entries_tenant_account";--> statement-breakpoint
CREATE INDEX "idx_ledger_entries_tenant_account"
  ON "ledger_entries" USING btree ("tenant_id", "account_id", "created_at")
  INCLUDE ("entry_type", "amount");--> statement-breakpoint

ALTER TABLE "accounts"
  ADD CONSTRAINT "chk_accounts_currency_format"
  CHECK ("currency" ~ '^[A-Z]{3}$');--> statement-breakpoint

ALTER TABLE "accounts"
  ADD CONSTRAINT "chk_accounts_owner_id_non_empty"
  CHECK (btrim("owner_id") <> '');--> statement-breakpoint

ALTER TABLE "accounts"
  ADD CONSTRAINT "chk_accounts_sys_namespace"
  CHECK (
    ("category" IN ('SYSTEM_CLEARING', 'PLATFORM_REVENUE', 'SETTLEMENT_TRANSIT'))
    = (lower("owner_id") LIKE 'sys_%')
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_accounts_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_net_balance BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable ledger violation: DELETE operations are strictly prohibited on accounts (id: %). Transition status to CLOSED instead.',
      OLD.id;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.category IS DISTINCT FROM OLD.category
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Immutable ledger violation: Core account identity fields (id, tenant_id, owner_id, category, currency, created_at) cannot be modified on account %',
        OLD.id;
    END IF;

    IF OLD.status = 'CLOSED' AND NEW.status IS DISTINCT FROM 'CLOSED' THEN
      RAISE EXCEPTION 'Account lifecycle violation: account % is CLOSED and cannot be reopened to %',
        OLD.id, NEW.status;
    END IF;

    IF OLD.status != 'CLOSED' AND NEW.status = 'CLOSED' THEN
      SELECT COALESCE(
        SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END),
        0
      )
      INTO v_net_balance
      FROM ledger_entries
      WHERE tenant_id = NEW.tenant_id
        AND account_id = NEW.id;

      IF v_net_balance != 0 THEN
        RAISE EXCEPTION 'Account closure violation: cannot close account % with non-zero balance (% minor units)',
          NEW.id, ABS(v_net_balance);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_accounts_immutability ON accounts;--> statement-breakpoint
CREATE TRIGGER trg_accounts_immutability
  BEFORE UPDATE OR DELETE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION enforce_accounts_immutability();--> statement-breakpoint

-- Updates existing trigger functions attached in 0001_ledger_security_triggers.sql
CREATE OR REPLACE FUNCTION enforce_ledger_entries_immutability()
RETURNS TRIGGER AS $$
DECLARE
  parent_status    tx_status;
  parent_tenant_id VARCHAR(100);
  acc_currency     VARCHAR(3);
  acc_tenant_id    VARCHAR(100);
  acc_status       account_status;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Immutable ledger violation: UPDATE operations are strictly prohibited on ledger_entries (id: %)',
      OLD.id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable ledger violation: DELETE operations are strictly prohibited on ledger_entries (id: %)',
      OLD.id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.amount <= 0 THEN
      RAISE EXCEPTION 'Invalid ledger entry: amount (%) must be strictly greater than 0',
        NEW.amount;
    END IF;

    SELECT status, tenant_id
      INTO parent_status, parent_tenant_id
      FROM transactions
     WHERE id = NEW.transaction_id;

    IF parent_status IS NULL THEN
      RAISE EXCEPTION 'Orphan ledger entry: parent transaction % does not exist',
        NEW.transaction_id;
    END IF;

    IF parent_tenant_id != NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant violation: ledger entry tenant (%) does not match parent transaction tenant (%)',
        NEW.tenant_id, parent_tenant_id;
    END IF;

    IF parent_status != 'PENDING' THEN
      RAISE EXCEPTION 'Transaction locked: cannot insert ledger entries into a transaction with status % (transaction_id: %)',
        parent_status, NEW.transaction_id;
    END IF;

    SELECT currency, tenant_id, status
      INTO acc_currency, acc_tenant_id, acc_status
      FROM accounts
     WHERE id = NEW.account_id
       FOR SHARE;

    IF acc_currency IS NULL THEN
      RAISE EXCEPTION 'Orphan ledger entry: target account % does not exist',
        NEW.account_id;
    END IF;

    IF acc_tenant_id != NEW.tenant_id THEN
      RAISE EXCEPTION 'Cross-tenant violation: ledger entry tenant (%) does not match target account tenant (%) for account %',
        NEW.tenant_id, acc_tenant_id, NEW.account_id;
    END IF;

    IF acc_status != 'ACTIVE' THEN
      RAISE EXCEPTION 'Account status violation: cannot post ledger entries to a % account (%)',
        acc_status, NEW.account_id;
    END IF;

    IF acc_currency != NEW.currency THEN
      RAISE EXCEPTION 'Currency mismatch: entry currency (%) does not match account currency (%) for account %',
        NEW.currency, acc_currency, NEW.account_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_transactions_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Audit trail violation: DELETE operations are strictly prohibited on transactions (id: %)',
      OLD.id;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'COMPLETED' THEN
      RAISE EXCEPTION 'Terminal state violation: transaction % is COMPLETED and permanently immutable. Create a REFUND or ADJUSTMENT transaction instead.',
        OLD.id;
    END IF;

    IF OLD.status = 'FAILED' THEN
      RAISE EXCEPTION 'Terminal state violation: transaction % is FAILED and cannot be modified or resurrected.',
        OLD.id;
    END IF;

    IF OLD.status = 'PENDING' THEN
      IF NEW.status NOT IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'Invalid state transition: transaction % cannot transition from PENDING to %',
          OLD.id, NEW.status;
      END IF;

      IF NEW.id != OLD.id
         OR NEW.tenant_id != OLD.tenant_id
         OR NEW.idempotency_key != OLD.idempotency_key
         OR NEW.type != OLD.type
         OR NEW.created_at != OLD.created_at THEN
        RAISE EXCEPTION 'Tamper violation: immutable columns (id, tenant_id, idempotency_key, type, created_at) cannot be modified on transaction %',
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
