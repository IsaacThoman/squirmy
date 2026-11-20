ALTER TABLE "recordings" ADD COLUMN "album_hint_id" uuid;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_album_hint_id_albums_id_fk" FOREIGN KEY ("album_hint_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "albums_match_key_trgm" ON "albums" USING gin ("match_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "albums_title_key_prefix" ON "albums" USING btree ("title_key" collate "C");--> statement-breakpoint
CREATE INDEX "artists_name_key_prefix" ON "artists" USING btree ("name_key" collate "C");--> statement-breakpoint
CREATE INDEX "recordings_match_key_trgm" ON "recordings" USING gin ("match_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "recordings_title_key_prefix" ON "recordings" USING btree ("title_key" collate "C");--> statement-breakpoint
CREATE INDEX "recordings_album_hint" ON "recordings" USING btree ("album_hint_id");