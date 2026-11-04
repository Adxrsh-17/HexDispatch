CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"txn_id" text NOT NULL,
	"account" text NOT NULL,
	"debit" integer DEFAULT 0 NOT NULL,
	"credit" integer DEFAULT 0 NOT NULL,
	"ride_id" text,
	"driver_id" text,
	"description" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_sagas" (
	"ride_id" text PRIMARY KEY NOT NULL,
	"step" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"payload" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ride_id" text NOT NULL,
	"status" text NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"psp_ref" text,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"driver_id" text NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text NOT NULL,
	"statement_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"consumer" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psp_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"psp_ref" text NOT NULL,
	"ride_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"status" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "psp_records_psp_ref_unique" UNIQUE("psp_ref"),
	CONSTRAINT "psp_records_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "idx_ledger_txn_id" ON "ledger_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_account" ON "ledger_entries" USING btree ("account");--> statement-breakpoint
CREATE INDEX "idx_ledger_ride_id" ON "ledger_entries" USING btree ("ride_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_driver_id" ON "ledger_entries" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_sagas_state" ON "payment_sagas" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_sagas_step" ON "payment_sagas" USING btree ("step");--> statement-breakpoint
CREATE INDEX "idx_payments_ride_id" ON "payments" USING btree ("ride_id");--> statement-breakpoint
CREATE INDEX "idx_payments_status" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_payouts_driver_id" ON "payouts" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX "idx_payouts_status" ON "payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_psp_records_ride_id" ON "psp_records" USING btree ("ride_id");--> statement-breakpoint
CREATE INDEX "idx_psp_records_kind" ON "psp_records" USING btree ("kind");