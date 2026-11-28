ALTER TABLE "media_files" ADD COLUMN "decoded_frames" bigint;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "decoded_rate" integer;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "priming_frames" integer;--> statement-breakpoint
ALTER TABLE "media_files" ADD COLUMN "padding_frames" integer;