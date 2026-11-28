CREATE TABLE "recording_credits" (
	"recording_id" uuid,
	"file_id" uuid,
	"artist_id" uuid NOT NULL,
	"role" text NOT NULL,
	"instrument" text DEFAULT '' NOT NULL,
	CONSTRAINT "recording_credits_owner" CHECK (num_nonnulls("recording_credits"."recording_id", "recording_credits"."file_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "recording_works" (
	"recording_id" uuid,
	"file_id" uuid,
	"work_id" uuid NOT NULL,
	"movement_name" text,
	"movement_number" integer,
	"movement_total" integer,
	CONSTRAINT "recording_works_owner" CHECK (num_nonnulls("recording_works"."recording_id", "recording_works"."file_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mbid" uuid,
	"tag_key" text,
	"title" text NOT NULL,
	CONSTRAINT "works_identity" CHECK (num_nonnulls("works"."mbid", "works"."tag_key") = 1)
);
--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "tag_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_credits" ADD CONSTRAINT "recording_credits_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_credits" ADD CONSTRAINT "recording_credits_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_credits" ADD CONSTRAINT "recording_credits_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_works" ADD CONSTRAINT "recording_works_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_works" ADD CONSTRAINT "recording_works_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_works" ADD CONSTRAINT "recording_works_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_credits_recording" ON "recording_credits" USING btree ("recording_id","artist_id","role","instrument") WHERE "recording_credits"."recording_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_credits_file" ON "recording_credits" USING btree ("file_id","artist_id","role","instrument") WHERE "recording_credits"."file_id" is not null;--> statement-breakpoint
CREATE INDEX "recording_credits_artist_role" ON "recording_credits" USING btree ("artist_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_works_recording" ON "recording_works" USING btree ("recording_id","work_id") WHERE "recording_works"."recording_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_works_file" ON "recording_works" USING btree ("file_id","work_id") WHERE "recording_works"."file_id" is not null;--> statement-breakpoint
CREATE INDEX "recording_works_work" ON "recording_works" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "works_mbid" ON "works" USING btree ("mbid");--> statement-breakpoint
CREATE UNIQUE INDEX "works_tag_key" ON "works" USING btree ("tag_key");