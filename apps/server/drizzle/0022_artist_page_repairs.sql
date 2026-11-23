-- MusicBrainz's placeholder artists (Various Artists, [anonymous], [no artist],
-- [traditional], [unknown]; metadata/musicbrainz.ts specialPurposeArtists) stand for no
-- one: enrichment no longer stores a bio, genres, disambiguation (a note to MusicBrainz's
-- editors) or a picture from the web for them. Rows stored before lose theirs; a picture
-- from the user's folders stays.
UPDATE "artists" a SET "bio" = NULL, "bio_source" = NULL, "bio_url" = NULL, "disambiguation" = NULL, "genres" = '{}',
  "image_asset_id" = CASE WHEN EXISTS (SELECT 1 FROM "assets" s WHERE s."id" = a."image_asset_id" AND s."source" ~* '^https?://') THEN NULL ELSE a."image_asset_id" END,
  "updated_at" = now()
WHERE a."mbid" IN ('89ad4ac3-39f7-470e-963a-56509c546377', 'f731ccc4-e22a-43af-a747-64213329e088', 'eec63d3c-3b81-4ad4-b1e4-7c147d4d2b61',
    '9be7f096-97ec-4615-8957-8d40b5dcbc41', '125ec42a-7229-4250-afc5-e057484327fe')
  AND (a."bio" IS NOT NULL OR a."disambiguation" IS NOT NULL OR cardinality(a."genres") > 0
    OR EXISTS (SELECT 1 FROM "assets" s WHERE s."id" = a."image_asset_id" AND s."source" ~* '^https?://'));
--> statement-breakpoint
-- MusicBrainz singles, EPs and "Other" releases with a Soundtrack secondary type were typed
-- soundtrack (metadata/musicbrainz.ts albumType), so a film's single sat under an artist's
-- Albums or Soundtracks rather than Singles. Stored rows lack the primary type, so the
-- artists leading such rows fetch their discography again, which types them anew: on their
-- next visit, or from the enrichment sweep for artists in the library (as stale.ts does).
UPDATE "artists" ar SET "detail_level" = least(ar."detail_level", 1), "fetched_at" = NULL
WHERE ar."mbid" IS NOT NULL AND ar."merged_into_id" IS NULL AND ar."fetched_at" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "albums" a WHERE a."primary_artist_id" = ar."id" AND a."mbid" IS NOT NULL AND a."merged_into_id" IS NULL AND a."type" = 'soundtrack');
