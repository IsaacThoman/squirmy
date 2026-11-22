ALTER TABLE "albums" ADD COLUMN "type_guessed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Album rows without a MusicBrainz id or files that say 'album' were, before this column,
-- mostly made from a track's album reference (which names no type) or from tags, where
-- 'album' was only the default. Marking them lets the release repair (enrichment.reconcile)
-- fold them into the artist's release of the same title whatever its type.
UPDATE "albums" a SET "type_guessed" = true
WHERE a."mbid" IS NULL AND a."type" = 'album' AND a."merged_into_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "media_files" f WHERE f."album_id" = a."id");
--> statement-breakpoint
-- Merges now move album hints with everything else; hints from older merges follow suit.
-- A merge points every redirect straight at the winner, so one hop is enough.
UPDATE "recordings" r SET "album_hint_id" = a."merged_into_id"
FROM "albums" a WHERE a."id" = r."album_hint_id" AND a."merged_into_id" IS NOT NULL;
