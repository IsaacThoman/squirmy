ALTER TABLE "imports" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "step" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "step_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "received_files" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "received_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "work" jsonb;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "imports_status" ON "imports" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "imports_user" ON "imports" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "media_files_import" ON "media_files" USING btree ("import_id");