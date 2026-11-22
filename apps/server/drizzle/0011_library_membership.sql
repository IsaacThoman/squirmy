CREATE TABLE "library_items" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_items_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "cached" boolean GENERATED ALWAYS AS (source like 'provider:%') STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_items_user_recent" ON "library_items" USING btree ("user_id","entity_type","created_at" DESC NULLS LAST,"entity_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "library_items_entity" ON "library_items" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "media_files_collection_recent" ON "media_files" USING btree ("added_at","id") WHERE "media_files"."missing_since" is null and not "media_files"."cached";--> statement-breakpoint
CREATE INDEX "media_files_collection_album" ON "media_files" USING btree ("album_id","added_at","id") WHERE "media_files"."missing_since" is null and not "media_files"."cached";--> statement-breakpoint
CREATE INDEX "media_files_collection_recording" ON "media_files" USING btree ("recording_id","added_at","id") WHERE "media_files"."missing_since" is null and not "media_files"."cached";--> statement-breakpoint
-- "Get this album" was an explicit add: completed album fetches become saves of the user
-- who asked, at the album that finally holds the data after merges. With a provider that
-- only takes single tracks it made one job per missing track at once; playing makes at
-- most three at a time (the current track and two ahead), so four or more track jobs of
-- one requester for one album within five seconds count as an album request. Other
-- single-track fetches came from pressing play and stay out of the library.
WITH RECURSIVE "saved" AS (
	SELECT "requested_by" AS "user_id", "album_id", "completed_at"
	FROM "acquisition_jobs"
	WHERE "recording_id" IS NULL AND "album_id" IS NOT NULL AND "status" = 'completed' AND "requested_by" IS NOT NULL
	UNION ALL
	SELECT "job"."requested_by", "job"."album_id", "job"."completed_at"
	FROM "acquisition_jobs" "job"
	WHERE "job"."recording_id" IS NOT NULL AND "job"."album_id" IS NOT NULL AND "job"."status" = 'completed' AND "job"."requested_by" IS NOT NULL
		AND (
			SELECT count(*) FROM "acquisition_jobs" "burst"
			WHERE "burst"."requested_by" = "job"."requested_by" AND "burst"."album_id" = "job"."album_id" AND "burst"."recording_id" IS NOT NULL
				AND "burst"."created_at" BETWEEN "job"."created_at" - interval '5 seconds' AND "job"."created_at" + interval '5 seconds'
		) >= 4
), "resolved" AS (
	SELECT "saved"."user_id", "albums"."id", "albums"."merged_into_id", "saved"."completed_at", 0 AS "depth"
	FROM "saved" JOIN "albums" ON "albums"."id" = "saved"."album_id"
	UNION ALL
	SELECT "resolved"."user_id", "albums"."id", "albums"."merged_into_id", "resolved"."completed_at", "resolved"."depth" + 1
	FROM "resolved" JOIN "albums" ON "albums"."id" = "resolved"."merged_into_id"
	WHERE "resolved"."depth" < 32
)
INSERT INTO "library_items" ("user_id", "entity_type", "entity_id", "created_at")
SELECT "user_id", 'album', "id", min(coalesce("completed_at", now()))
FROM "resolved" WHERE "merged_into_id" IS NULL
GROUP BY "user_id", "id"
ON CONFLICT DO NOTHING;
