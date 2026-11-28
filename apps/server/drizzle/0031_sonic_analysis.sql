CREATE TABLE "sonic_analyses" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"audio_hash" text,
	"version" smallint,
	"error" text,
	"analyzed_ms" integer,
	"bpm" real,
	"bpm_confidence" real,
	"beat_offset_ms" integer,
	"key" smallint,
	"mode" text,
	"key_strength" real,
	"tuning_cents" smallint,
	"level_db" real,
	"dynamic_range_db" real,
	"onset_rate" real,
	"centroid_hz" real,
	"energy" real,
	"danceability" real,
	"audible_start_ms" integer,
	"audible_end_ms" integer,
	"intro_end_ms" integer,
	"outro_start_ms" integer,
	"vector" real[],
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sonic_hints" (
	"recording_id" uuid PRIMARY KEY NOT NULL,
	"deezer_bpm" real,
	"deezer_checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sonic_analyses" ADD CONSTRAINT "sonic_analyses_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonic_hints" ADD CONSTRAINT "sonic_hints_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;