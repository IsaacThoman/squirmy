ALTER TABLE "plays" ADD COLUMN "skipped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plays" ADD COLUMN "context_type" text;--> statement-breakpoint
ALTER TABLE "plays" ADD COLUMN "context_id" text;