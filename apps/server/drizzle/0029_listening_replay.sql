CREATE TABLE "history_imported_plays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"fingerprint" text NOT NULL,
	"play_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ms_played" integer,
	"skipped" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"album" text,
	"track_key" text NOT NULL,
	"artist_key" text NOT NULL,
	"album_key" text
);
--> statement-breakpoint
CREATE TABLE "history_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"json_lines" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"ignored" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
DROP INDEX "plays_user_recent";--> statement-breakpoint
ALTER TABLE "history_imported_plays" ADD CONSTRAINT "history_imported_plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_imported_plays" ADD CONSTRAINT "history_imported_plays_play_id_plays_id_fk" FOREIGN KEY ("play_id") REFERENCES "public"."plays"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_imports" ADD CONSTRAINT "history_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "history_imported_plays_fingerprint" ON "history_imported_plays" USING btree ("user_id","source","fingerprint");--> statement-breakpoint
CREATE INDEX "history_imported_plays_link" ON "history_imported_plays" USING btree ("play_id") WHERE "history_imported_plays"."play_id" is not null;--> statement-breakpoint
CREATE INDEX "history_imported_plays_unmatched_recent" ON "history_imported_plays" USING btree ("user_id","started_at","id") WHERE "history_imported_plays"."play_id" is null;--> statement-breakpoint
CREATE INDEX "history_imports_user_recent" ON "history_imports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "plays_user_recent" ON "plays" USING btree ("user_id","started_at","id");