CREATE TABLE "artist_top_tracks" (
	"artist_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"recording_id" uuid NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_top_tracks_artist_id_position_pk" PRIMARY KEY("artist_id","position")
);
--> statement-breakpoint
ALTER TABLE "artists" ADD COLUMN "image_picked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artist_top_tracks" ADD CONSTRAINT "artist_top_tracks_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_top_tracks" ADD CONSTRAINT "artist_top_tracks_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_top_tracks_recording" ON "artist_top_tracks" USING btree ("recording_id");--> statement-breakpoint
-- Remix albums and DJ mixes are compilations (metadata/musicbrainz.ts albumType); rows
-- typed before that said 'album' and filled the artist's Albums.
UPDATE "albums" SET "type" = 'compilation', "updated_at" = now()
WHERE "type" = 'album' AND "mbid" IS NOT NULL AND "merged_into_id" IS NULL
  AND EXISTS (SELECT 1 FROM unnest("secondary_types") t WHERE lower(t) IN ('remix', 'dj-mix'));
--> statement-breakpoint
-- Wikipedia summaries drop parentheticals and leave their separators behind
-- ("Thom Yorke ; brothers …"); the same cleanup metadata/wikidata.ts now applies.
UPDATE "artists" SET "bio" = btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace("bio",
    '\(\s*[;,]?\s*\)', '', 'g'),
    '\(\s*[;,]\s*', '(', 'g'),
    '\s+([;,])', '\1', 'g'),
    '\s+\.(\s|$)', '.\1', 'g'),
    ' {2,}', ' ', 'g')), "updated_at" = now()
WHERE "bio_source" = 'wikipedia' AND "bio" ~ '(\s[;,]|\s\.(\s|$)|\(\s*[;,]| {2})';
