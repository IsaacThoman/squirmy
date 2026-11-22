ALTER TABLE "acquisition_jobs" ADD COLUMN "origin" text DEFAULT 'play' NOT NULL;--> statement-breakpoint
ALTER TABLE "acquisition_providers" ADD COLUMN "coverage_override" text;--> statement-breakpoint
-- Jobs from before origins were stored: an album job was an explicit "Get this album";
-- recording jobs came from pressing play, which the column's default already says.
UPDATE "acquisition_jobs" SET "origin" = 'library' WHERE "recording_id" IS NULL AND "album_id" IS NOT NULL;--> statement-breakpoint
-- Deliveries no longer open reviews: close the ones listening opened, where every present
-- file of the group is cache. Groups with a file someone brought keep theirs.
UPDATE "match_reviews" "review" SET "status" = 'dismissed', "resolved_at" = now()
WHERE "review"."status" = 'open'
	AND EXISTS (
		SELECT 1 FROM "media_files" "f"
		WHERE "f"."root_id" = "review"."root_id" AND "f"."group_key" = "review"."group_key" AND "f"."missing_since" IS NULL
	)
	AND NOT EXISTS (
		SELECT 1 FROM "media_files" "f"
		WHERE "f"."root_id" = "review"."root_id" AND "f"."group_key" = "review"."group_key" AND "f"."missing_since" IS NULL AND NOT "f"."cached"
	);
