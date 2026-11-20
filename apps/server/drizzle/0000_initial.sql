CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "acquisition_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"requested_by" uuid,
	"recording_id" uuid,
	"album_id" uuid,
	"offer" jsonb,
	"status" text DEFAULT 'resolving' NOT NULL,
	"error" text,
	"idempotency_key" text NOT NULL,
	"provider_job_id" text,
	"upload_token_hash" text,
	"import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "acquisition_misses" (
	"provider_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acquisition_misses_provider_id_entity_type_entity_id_pk" PRIMARY KEY("provider_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "acquisition_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"coverage" text DEFAULT 'must_resolve' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"capabilities" jsonb,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "album_artists" (
	"album_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"artist_id" uuid NOT NULL,
	"credited_name" text NOT NULL,
	"join_phrase" text DEFAULT '' NOT NULL,
	CONSTRAINT "album_artists_album_id_position_pk" PRIMARY KEY("album_id","position")
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mbid" uuid,
	"title" text NOT NULL,
	"artist_credit" text NOT NULL,
	"primary_artist_id" uuid,
	"type" text DEFAULT 'album' NOT NULL,
	"secondary_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"release_date" text,
	"year" integer,
	"title_key" text NOT NULL,
	"match_key" text NOT NULL,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"description_source" text,
	"artwork_asset_id" uuid,
	"canonical_release_id" uuid,
	"detail_level" smallint DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_passwords" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mbid" uuid,
	"name" text NOT NULL,
	"sort_name" text,
	"disambiguation" text,
	"kind" text,
	"country" text,
	"name_key" text NOT NULL,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_asset_id" uuid,
	"bio" text,
	"bio_source" text,
	"bio_url" text,
	"detail_level" smallint DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"color" text,
	"thumbhash" text,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" text,
	"client_kind" text DEFAULT 'other' NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_index" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_index_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"mbid" uuid NOT NULL,
	"name" text NOT NULL,
	"artist_name" text,
	"album_name" text,
	"name_key" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "external_ids" (
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ids_provider_entity_type_external_id_pk" PRIMARY KEY("provider","entity_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "file_moves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"file_id" uuid,
	"kind" text DEFAULT 'audio' NOT NULL,
	"from_rel_path" text NOT NULL,
	"to_rel_path" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "http_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"status" integer NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"acquisition_job_id" uuid,
	"target_root_id" uuid,
	"status" text DEFAULT 'receiving' NOT NULL,
	"staging_path" text NOT NULL,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"can_upload" boolean DEFAULT false NOT NULL,
	"can_acquire" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_roots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"mode" text DEFAULT 'read_only' NOT NULL,
	"template" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"watch" boolean DEFAULT true NOT NULL,
	"scan_interval_minutes" integer DEFAULT 1440 NOT NULL,
	"last_scan_started_at" timestamp with time zone,
	"last_scan_finished_at" timestamp with time zone,
	"last_scan_stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "lyrics" (
	"recording_id" uuid PRIMARY KEY NOT NULL,
	"synced" text,
	"plain" text,
	"instrumental" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"language" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"summary" jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"rel_path" text NOT NULL,
	"size" bigint NOT NULL,
	"mtime" timestamp with time zone NOT NULL,
	"audio_hash" text,
	"container" text NOT NULL,
	"codec" text NOT NULL,
	"lossless" boolean DEFAULT false NOT NULL,
	"bitrate" integer,
	"sample_rate" integer,
	"bit_depth" smallint,
	"channels" smallint,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedded_art_asset_id" uuid,
	"loudness_lufs" real,
	"true_peak_db" real,
	"tag_track_gain_db" real,
	"tag_track_peak" real,
	"tag_album_gain_db" real,
	"tag_album_peak" real,
	"fingerprint" text,
	"acoustid" text,
	"group_key" text,
	"recording_id" uuid,
	"release_track_id" uuid,
	"release_id" uuid,
	"album_id" uuid,
	"match_status" text DEFAULT 'pending' NOT NULL,
	"match_locked" boolean DEFAULT false NOT NULL,
	"match_confidence" real,
	"match_source" text,
	"source" text DEFAULT 'scan' NOT NULL,
	"import_id" uuid,
	"probe_stage" smallint DEFAULT 0 NOT NULL,
	"missing_since" timestamp with time zone,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organize_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"root_id" uuid NOT NULL,
	"created_by" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "playback_sessions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"queue_version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"playlist_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"recording_id" uuid NOT NULL,
	"album_id" uuid,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"album_id" uuid,
	"device_id" text,
	"client" text DEFAULT 'app' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ms_played" integer DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ratings" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "recording_artists" (
	"recording_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"artist_id" uuid NOT NULL,
	"credited_name" text NOT NULL,
	"join_phrase" text DEFAULT '' NOT NULL,
	CONSTRAINT "recording_artists_recording_id_position_pk" PRIMARY KEY("recording_id","position")
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mbid" uuid,
	"title" text NOT NULL,
	"artist_credit" text NOT NULL,
	"primary_artist_id" uuid,
	"duration_ms" integer,
	"isrcs" text[] DEFAULT '{}'::text[] NOT NULL,
	"title_key" text NOT NULL,
	"match_key" text NOT NULL,
	"popularity" real,
	"explicit" boolean,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_loudness" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"loudness_lufs" real NOT NULL,
	"true_peak_db" real NOT NULL,
	"file_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_tracks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mbid" uuid,
	"release_id" uuid NOT NULL,
	"disc" smallint DEFAULT 1 NOT NULL,
	"position" smallint NOT NULL,
	"recording_id" uuid NOT NULL,
	"title" text NOT NULL,
	"artist_credit" text,
	"duration_ms" integer,
	"disc_title" text
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mbid" uuid,
	"album_id" uuid NOT NULL,
	"title" text NOT NULL,
	"release_date" text,
	"country" text,
	"label" text,
	"catalog_number" text,
	"barcode" text,
	"format" text,
	"status" text,
	"track_count" integer DEFAULT 0 NOT NULL,
	"disc_count" integer DEFAULT 1 NOT NULL,
	"detail_level" smallint DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrobble_deliveries" (
	"play_id" uuid NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrobble_deliveries_play_id_target_pk" PRIMARY KEY("play_id","target")
);
--> statement-breakpoint
CREATE TABLE "server_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"profile" text NOT NULL,
	"storage_path" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"username_key" text NOT NULL,
	"display_name" text,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"can_upload" boolean DEFAULT false NOT NULL,
	"can_acquire" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wants" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	CONSTRAINT "wants_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "acquisition_jobs" ADD CONSTRAINT "acquisition_jobs_provider_id_acquisition_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."acquisition_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_jobs" ADD CONSTRAINT "acquisition_jobs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_jobs" ADD CONSTRAINT "acquisition_jobs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_jobs" ADD CONSTRAINT "acquisition_jobs_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_misses" ADD CONSTRAINT "acquisition_misses_provider_id_acquisition_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."acquisition_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_artists" ADD CONSTRAINT "album_artists_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_artists" ADD CONSTRAINT "album_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_primary_artist_id_artists_id_fk" FOREIGN KEY ("primary_artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_passwords" ADD CONSTRAINT "app_passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_moves" ADD CONSTRAINT "file_moves_batch_id_organize_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."organize_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_target_root_id_library_roots_id_fk" FOREIGN KEY ("target_root_id") REFERENCES "public"."library_roots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lyrics" ADD CONSTRAINT "lyrics_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_reviews" ADD CONSTRAINT "match_reviews_root_id_library_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_reviews" ADD CONSTRAINT "match_reviews_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_root_id_library_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_release_track_id_release_tracks_id_fk" FOREIGN KEY ("release_track_id") REFERENCES "public"."release_tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organize_batches" ADD CONSTRAINT "organize_batches_root_id_library_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."library_roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organize_batches" ADD CONSTRAINT "organize_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_artists" ADD CONSTRAINT "recording_artists_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_artists" ADD CONSTRAINT "recording_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_primary_artist_id_artists_id_fk" FOREIGN KEY ("primary_artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_loudness" ADD CONSTRAINT "release_loudness_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tracks" ADD CONSTRAINT "release_tracks_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tracks" ADD CONSTRAINT "release_tracks_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrobble_deliveries" ADD CONSTRAINT "scrobble_deliveries_play_id_plays_id_fk" FOREIGN KEY ("play_id") REFERENCES "public"."plays"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcodes" ADD CONSTRAINT "transcodes_file_id_media_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."media_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wants" ADD CONSTRAINT "wants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acquisition_jobs_idempotency" ON "acquisition_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "acquisition_jobs_recording" ON "acquisition_jobs" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "acquisition_jobs_status" ON "acquisition_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "album_artists_artist" ON "album_artists" USING btree ("artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "albums_mbid" ON "albums" USING btree ("mbid");--> statement-breakpoint
CREATE INDEX "albums_title_key_trgm" ON "albums" USING gin ("title_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "albums_match_key" ON "albums" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "albums_primary_artist" ON "albums" USING btree ("primary_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_passwords_key_hash" ON "app_passwords" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "app_passwords_user" ON "app_passwords" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artists_mbid" ON "artists" USING btree ("mbid");--> statement-breakpoint
CREATE INDEX "artists_name_key_trgm" ON "artists" USING gin ("name_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "artists_name_key" ON "artists" USING btree ("name_key");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_sha256" ON "assets" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "catalog_index_key_trgm" ON "catalog_index" USING gin ("name_key" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_index_kind_mbid" ON "catalog_index" USING btree ("kind","mbid");--> statement-breakpoint
CREATE INDEX "external_ids_entity" ON "external_ids" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "file_moves_batch" ON "file_moves" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "http_cache_expires" ON "http_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_code" ON "invites" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "library_roots_path" ON "library_roots" USING btree ("path");--> statement-breakpoint
CREATE INDEX "likes_user_recent" ON "likes" USING btree ("user_id","entity_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "match_reviews_group" ON "match_reviews" USING btree ("root_id","group_key");--> statement-breakpoint
CREATE INDEX "match_reviews_status" ON "match_reviews" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_path" ON "media_files" USING btree ("root_id","rel_path");--> statement-breakpoint
CREATE INDEX "media_files_audio_hash" ON "media_files" USING btree ("audio_hash");--> statement-breakpoint
CREATE INDEX "media_files_recording" ON "media_files" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "media_files_album" ON "media_files" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "media_files_release" ON "media_files" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "media_files_group" ON "media_files" USING btree ("root_id","group_key");--> statement-breakpoint
CREATE INDEX "media_files_match_status" ON "media_files" USING btree ("match_status");--> statement-breakpoint
CREATE INDEX "media_files_added" ON "media_files" USING btree ("added_at");--> statement-breakpoint
CREATE INDEX "playlist_items_order" ON "playlist_items" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "playlists_owner" ON "playlists" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "plays_user_recent" ON "plays" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "plays_recording" ON "plays" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "recording_artists_artist" ON "recording_artists" USING btree ("artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_mbid" ON "recordings" USING btree ("mbid");--> statement-breakpoint
CREATE INDEX "recordings_title_key_trgm" ON "recordings" USING gin ("title_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "recordings_match_key" ON "recordings" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "recordings_isrcs" ON "recordings" USING gin ("isrcs");--> statement-breakpoint
CREATE INDEX "recordings_primary_artist" ON "recordings" USING btree ("primary_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_tracks_position" ON "release_tracks" USING btree ("release_id","disc","position");--> statement-breakpoint
CREATE INDEX "release_tracks_recording" ON "release_tracks" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_mbid" ON "releases" USING btree ("mbid");--> statement-breakpoint
CREATE INDEX "releases_album" ON "releases" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "releases_barcode" ON "releases" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "scrobble_deliveries_status" ON "scrobble_deliveries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "transcodes_file_profile" ON "transcodes" USING btree ("file_id","profile");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_key" ON "users" USING btree ("username_key");