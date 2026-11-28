CREATE TABLE "tv_pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text NOT NULL,
	"ip_address" text NOT NULL,
	"user_agent" text,
	"approver_session_id" uuid,
	"interval_seconds" integer NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tv_pairings_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "tv_pairings_user_code_hash_unique" UNIQUE("user_code_hash")
);
--> statement-breakpoint
CREATE INDEX "tv_pairings_expires_at" ON "tv_pairings" USING btree ("expires_at");