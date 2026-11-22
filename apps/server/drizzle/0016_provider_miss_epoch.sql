ALTER TABLE "acquisition_misses" ADD COLUMN "provider_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "acquisition_misses" ADD COLUMN "provider_identity" text;--> statement-breakpoint
ALTER TABLE "acquisition_providers" ADD COLUMN "identity" text;--> statement-breakpoint
ALTER TABLE "acquisition_providers" ADD COLUMN "miss_epoch" integer DEFAULT 0 NOT NULL;