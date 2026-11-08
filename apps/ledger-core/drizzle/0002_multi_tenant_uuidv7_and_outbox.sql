CREATE TYPE "public"."account_category" AS ENUM('SYSTEM_CLEARING', 'USER_WALLET', 'MERCHANT_PAYABLE', 'PLATFORM_REVENUE', 'SETTLEMENT_TRANSIT');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."tenant_env" AS ENUM('TEST', 'LIVE');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" varchar(100) PRIMARY KEY DEFAULT ('tnt_' || uuidv7()::text) NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"environment" "tenant_env" DEFAULT 'TEST' NOT NULL,
	"api_key_hash" varchar(64) NOT NULL,
	"webhook_url" varchar(512),
	"payout_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" varchar(100) NOT NULL,
	"aggregate_type" varchar(50) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_idempotency_key_unique";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "ledger_entries" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "tenant_id" varchar(100) DEFAULT 'tnt_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "category" "account_category" DEFAULT 'USER_WALLET' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tenant_id" varchar(100) DEFAULT 'tnt_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN "tenant_id" varchar(100) DEFAULT 'tnt_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "tenant_id" varchar(100) DEFAULT 'tnt_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_pkey";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "pk_idempotency_tenant_key" PRIMARY KEY("tenant_id","key");--> statement-breakpoint
CREATE INDEX "idx_tenants_api_key_hash" ON "tenants" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "idx_outbox_status_created" ON "outbox_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_outbox_tenant" ON "outbox_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_accounts_tenant_owner" ON "accounts" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transactions_tenant_idempotency" ON "transactions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_transactions_tenant_created" ON "transactions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ledger_entries_tenant_account" ON "ledger_entries" USING btree ("tenant_id","account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ledger_entries_tx" ON "ledger_entries" USING btree ("transaction_id");