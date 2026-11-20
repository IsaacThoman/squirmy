CREATE INDEX "albums_title_sort" ON "albums" USING btree (regexp_replace("title_key", '^(the|a|an) ', ''),"id");--> statement-breakpoint
CREATE INDEX "albums_artist_sort" ON "albums" USING btree (regexp_replace(split_part("match_key", '|', 1), '^(the|a|an) ', ''),regexp_replace("title_key", '^(the|a|an) ', ''),"id");--> statement-breakpoint
CREATE INDEX "albums_year_sort" ON "albums" USING btree (coalesce("year", 0) desc,regexp_replace("title_key", '^(the|a|an) ', ''),"id");--> statement-breakpoint
CREATE INDEX "artists_name_sort" ON "artists" USING btree (regexp_replace("name_key", '^(the|a|an) ', ''),"id");--> statement-breakpoint
CREATE INDEX "media_files_present_recent" ON "media_files" USING btree ("added_at","id") WHERE "media_files"."missing_since" is null;--> statement-breakpoint
CREATE INDEX "media_files_present_album" ON "media_files" USING btree ("album_id","added_at","id") WHERE "media_files"."missing_since" is null;--> statement-breakpoint
CREATE INDEX "media_files_present_recording" ON "media_files" USING btree ("recording_id","added_at","id") WHERE "media_files"."missing_since" is null;--> statement-breakpoint
CREATE INDEX "recordings_title_sort" ON "recordings" USING btree (regexp_replace("title_key", '^(the|a|an) ', ''),regexp_replace(split_part("match_key", '|', 1), '^(the|a|an) ', ''),"id");--> statement-breakpoint
CREATE INDEX "recordings_artist_sort" ON "recordings" USING btree (regexp_replace(split_part("match_key", '|', 1), '^(the|a|an) ', ''),regexp_replace("title_key", '^(the|a|an) ', ''),"id");