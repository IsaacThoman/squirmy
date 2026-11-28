ALTER TABLE "albums" ADD COLUMN "artwork_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "health_status" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "health_detail" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "health_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "media_files_health_due" ON "media_files" USING btree (coalesce("health_checked_at", '-infinity'::timestamptz),"id") WHERE "media_files"."missing_since" is null and not "media_files"."cached";--> statement-breakpoint
CREATE INDEX "media_files_health_requested" ON "media_files" USING btree ("health_requested_at") WHERE "media_files"."health_requested_at" is not null;