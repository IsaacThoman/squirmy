-- Use a Unicode-aware collation for SQL name normalization where one is available.
-- The bigram fallback itself uses code points and does not depend on collation.
DO $$
DECLARE source text;
BEGIN
  SELECT format('%I.%I', n.nspname, c.collname) INTO source
  FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
  WHERE n.nspname = 'pg_catalog' AND c.collname IN ('und-x-icu', 'pg_c_utf8', 'C.UTF-8', 'en_US.UTF-8', 'C')
    AND c.collencoding IN (-1, pg_char_to_encoding(getdatabaseencoding()))
  ORDER BY array_position(ARRAY['und-x-icu', 'pg_c_utf8', 'C.UTF-8', 'en_US.UTF-8', 'C'], c.collname::text)
  LIMIT 1;
  EXECUTE 'CREATE COLLATION public.search_unicode FROM ' || source;
END $$;
--> statement-breakpoint
-- The catalog's context names and playlist names have no application-side match keys.
CREATE FUNCTION search_name_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT trim(regexp_replace(
    replace(replace(replace(replace(replace(
      translate(lower(regexp_replace(normalize(value, NFKD),
        U&'[\0300-\036f\0483-\0489\064b-\065f\0670\3099-\309a]+', '', 'g') COLLATE public.search_unicode),
        'øđðłı''’`', 'oddli'),
      'æ', 'ae'), 'œ', 'oe'), 'ß', 'ss'), 'þ', 'th'), '&', ' and '),
    '[[:punct:][:space:]|]+', ' ', 'g'))
$$;
--> statement-breakpoint
CREATE FUNCTION search_unicode_bigrams(value text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT ARRAY(
    SELECT DISTINCT substr(word, i, 2) COLLATE "C"
    FROM regexp_split_to_table(
      translate(normalize(value, NFC), 'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶ',
        'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゕゖ'),
      '[ |]+') AS w(token)
    CROSS JOIN LATERAL (SELECT ' ' || token || ' ' AS word) padded
    CROSS JOIN LATERAL generate_series(1, length(word) - 1) AS g(i)
    WHERE octet_length(value) > length(value)
      AND octet_length(substr(word, i, 2)) > 2
  )
$$;
--> statement-breakpoint
-- The query's leading and internal bigrams suffice for prefix and later-word matches.
CREATE FUNCTION search_unicode_score(query text[], candidate text[]) RETURNS real
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT count(*)::real / greatest(1, cardinality(query))
  FROM unnest(query) AS q(gram)
  WHERE gram = ANY(candidate)
$$;
--> statement-breakpoint
CREATE FUNCTION search_lyric_text(plain text, synced text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(nullif(trim(plain), ''),
    regexp_replace(coalesce(synced, ''), '\[[0-9]+:[0-9]+([.:][0-9]+)?\]', '', 'g'))
$$;
--> statement-breakpoint
CREATE INDEX "albums_match_key_unicode" ON "albums" USING gin (search_unicode_bigrams("match_key"));--> statement-breakpoint
CREATE INDEX "artists_name_key_unicode" ON "artists" USING gin (search_unicode_bigrams("name_key"));--> statement-breakpoint
CREATE INDEX "catalog_index_unicode" ON "catalog_index" USING gin (search_unicode_bigrams("name_key")) WHERE head;--> statement-breakpoint
CREATE INDEX "catalog_index_artist_title" ON "catalog_index" USING btree ("kind",search_name_key("artist_name") collate "C","name_key" collate "C") WHERE artist_name is not null;--> statement-breakpoint
CREATE INDEX "catalog_index_album_title" ON "catalog_index" USING btree ("kind",search_name_key("album_name") collate "C","name_key" collate "C") WHERE album_name is not null;--> statement-breakpoint
CREATE INDEX "lyrics_search" ON "lyrics" USING gin (to_tsvector('simple', search_lyric_text("plain", "synced"))) WHERE not "lyrics"."instrumental";--> statement-breakpoint
CREATE INDEX "recordings_match_key_unicode" ON "recordings" USING gin (search_unicode_bigrams("match_key"));