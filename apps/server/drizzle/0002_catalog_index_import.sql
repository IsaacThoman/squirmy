CREATE TABLE "catalog_index_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"phase" text,
	"source" text,
	"dump_date" timestamp with time zone,
	"recordings_per_artist" integer,
	"bytes_read" bigint DEFAULT 0 NOT NULL,
	"total_bytes" bigint,
	"rows_read" bigint DEFAULT 0 NOT NULL,
	"artists" integer,
	"albums" integer,
	"recordings" integer,
	"error" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "catalog_index_key_trgm";--> statement-breakpoint
DROP INDEX "catalog_index_kind_mbid";--> statement-breakpoint
ALTER TABLE "catalog_index" ALTER COLUMN "score" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "catalog_index" ADD COLUMN "head" boolean NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_index_imports_state" ON "catalog_index_imports" USING btree ("state");--> statement-breakpoint
CREATE INDEX "catalog_index_artist_head" ON "catalog_index" USING gin ("name_key" gin_trgm_ops) WHERE kind = 'artist' and head;--> statement-breakpoint
CREATE INDEX "catalog_index_album_head" ON "catalog_index" USING gin ("name_key" gin_trgm_ops) WHERE kind = 'album' and head;--> statement-breakpoint
CREATE INDEX "catalog_index_recording_head" ON "catalog_index" USING gin ("name_key" gin_trgm_ops) WHERE kind = 'recording' and head;--> statement-breakpoint
CREATE INDEX "catalog_index_prefix" ON "catalog_index" USING btree ("kind",("name_key" collate "C"));--> statement-breakpoint
ALTER TABLE "catalog_index" DROP COLUMN "id";