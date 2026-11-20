DROP INDEX "assets_sha256";--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "mime" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "storage_path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "remote_url" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_remote_url" ON "assets" USING btree ("remote_url");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_sha256" ON "assets" USING btree ("sha256") WHERE "assets"."remote_url" is null;