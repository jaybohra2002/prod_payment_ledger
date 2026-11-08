DROP INDEX "idx_accounts_tenant_owner";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_accounts_tenant_owner_cat_curr" ON "accounts" USING btree ("tenant_id","owner_id","category","currency");