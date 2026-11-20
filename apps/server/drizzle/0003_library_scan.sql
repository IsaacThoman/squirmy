ALTER TABLE "media_files" ADD COLUMN "probe_error" text;--> statement-breakpoint
CREATE INDEX "media_files_scan_order" ON "media_files" USING btree ("root_id","rel_path" collate "C");--> statement-breakpoint
CREATE INDEX "media_files_release_track" ON "media_files" USING btree ("release_track_id");