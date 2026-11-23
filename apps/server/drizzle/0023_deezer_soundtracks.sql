-- Deezer has no soundtrack type, so albums only Deezer knows were typed albums, and a film
-- composer's scores (The Dark Knight (Original Motion Picture Soundtrack)) sat under Albums.
-- Rows whose title says so in a soundtrack's own words, or whose stored genres file them
-- under film music, become soundtracks now (deezer.ts SOUNDTRACK_TITLE; change both
-- together). Rows Deezer files under Films/Games with no such words are read by the release
-- repair (retypeDeezerSoundtracks). A row with a MusicBrainz id keeps MusicBrainz's type.
UPDATE "albums" a SET "type" = 'soundtrack', "updated_at" = now()
WHERE a."merged_into_id" IS NULL AND a."mbid" IS NULL AND a."type" = 'album'
  AND EXISTS (SELECT 1 FROM "external_ids" e WHERE e."provider" = 'deezer' AND e."entity_type" = 'album' AND e."entity_id" = a."id")
  AND (
    a."title" ~* '\y(?:original\s+(?:motion\s+picture|film|movie|television|tv|series|video\s+game|game)\s+(?:sound\s?track|score)|original\s+(?:sound\s?track|score)|(?:motion\s+picture|film|movie|video\s+game)\s+(?:sound\s?track|score)|music\s+from\s+(?:and\s+inspired\s+by\s+)?the\s+(?:original\s+)?(?:motion\s+picture|film|movie|(?:television\s+|tv\s+)?series|video\s+game))\y'
    OR EXISTS (SELECT 1 FROM unnest(a."genres") g WHERE lower(trim(g)) IN ('films/games', 'soundtrack', 'soundtracks', 'film scores'))
  );
