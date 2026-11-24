ALTER TABLE "catalog_index_imports" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_index_imports" ADD COLUMN "resumes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_index_imports" ADD COLUMN "resumed_at" timestamp with time zone;