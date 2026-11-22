-- Discographies of MusicBrainz's placeholder artists (Various Artists, [anonymous],
-- [no artist], [traditional], [unknown]) are no longer fetched: Various Artists alone
-- brought in some 266,000 compilations as album rows, which filled Home's new releases with
-- albums nobody asked about. Remove the rows those fetches made that nothing else uses: no
-- track list yet, no file, no user data, no Deezer or other link, and no row merged into them.
DELETE FROM "albums" "a"
USING "artists" "ar"
WHERE "ar"."id" = "a"."primary_artist_id"
	AND "ar"."mbid" IN (
		'89ad4ac3-39f7-470e-963a-56509c546377', 'f731ccc4-e22a-43af-a747-64213329e088', 'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61',
		'9be7f096-97ec-4615-8957-8d40b5dcbc41', '125ec42a-7229-4250-afc5-e057484327fe'
	)
	AND "a"."mbid" IS NOT NULL AND "a"."merged_into_id" IS NULL AND "a"."detail_level" <= 1
	AND NOT EXISTS (SELECT 1 FROM "releases" "r" WHERE "r"."album_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "media_files" "f" WHERE "f"."album_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "albums" "m" WHERE "m"."merged_into_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "external_ids" "e" WHERE "e"."entity_type" = 'album' AND "e"."entity_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "likes" WHERE "entity_type" = 'album' AND "entity_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "ratings" WHERE "entity_type" = 'album' AND "entity_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "wants" WHERE "entity_type" = 'album' AND "entity_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "library_items" WHERE "entity_type" = 'album' AND "entity_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "playlist_items" WHERE "album_id" = "a"."id")
	AND NOT EXISTS (SELECT 1 FROM "plays" WHERE "album_id" = "a"."id");--> statement-breakpoint
-- Their lazy covers were never downloaded and nothing shows them now (a URL listed again
-- gets a row again). Covers of release groups that still have a row stay for the repair below.
DELETE FROM "assets" "s"
WHERE "s"."status" IN ('remote', 'failed')
	AND "s"."remote_url" LIKE 'https://coverartarchive.org/release-group/%'
	AND NOT EXISTS (SELECT 1 FROM "albums" WHERE "artwork_asset_id" = "s"."id")
	AND NOT EXISTS (SELECT 1 FROM "artists" WHERE "image_asset_id" = "s"."id")
	AND NOT EXISTS (
		SELECT 1 FROM "albums"
		WHERE "mbid" = substring("s"."remote_url" FROM '^https://coverartarchive\.org/release-group/([0-9a-f-]{36})/')::uuid
	);--> statement-breakpoint
-- A sized Cover Art Archive front is now fetched as the original while archive.org has not
-- derived it yet (most releases of the last few days). Fronts that failed before are tried
-- again on their next request, and albums whose discography cover was unassigned for
-- answering 404 are offered it again; one the archive really has no front for is unassigned
-- once more and gets a cover from another source (enrichment.cover).
UPDATE "assets" SET "status" = 'remote', "checked_at" = NULL
WHERE "status" = 'failed' AND "remote_url" ~ '^https://coverartarchive\.org/(release|release-group)/[0-9a-f-]{36}/front-(250|500|1200)$';--> statement-breakpoint
UPDATE "albums" "a" SET "artwork_asset_id" = "s"."id", "updated_at" = now()
FROM "assets" "s"
WHERE "a"."artwork_asset_id" IS NULL AND "a"."merged_into_id" IS NULL AND "a"."mbid" IS NOT NULL
	AND "s"."remote_url" = 'https://coverartarchive.org/release-group/' || "a"."mbid"::text || '/front-500';
