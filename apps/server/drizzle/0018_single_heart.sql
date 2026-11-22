-- One heart: a like is a library save. The saves of "Add to library" (library_items) join the
-- likes; an entity in both keeps the earlier time, when it first entered the library. Rows
-- already point at merge winners (merges repointed both tables). Every step can run again:
-- the copy only runs while the old table is there, and the indexes are rebuilt by name.
DO $$
BEGIN
	IF to_regclass('public.library_items') IS NOT NULL THEN
		INSERT INTO "likes" ("user_id", "entity_type", "entity_id", "created_at")
		SELECT "user_id", "entity_type", "entity_id", "created_at" FROM "library_items"
		ON CONFLICT ("user_id", "entity_type", "entity_id") DO UPDATE SET "created_at" = least("likes"."created_at", excluded."created_at");
	END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "library_items" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "likes_user_recent";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "likes_entity" ON "likes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "likes_user_recent" ON "likes" USING btree ("user_id","entity_type","created_at" DESC NULLS LAST,"entity_id" DESC NULLS LAST);
