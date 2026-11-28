CREATE TABLE "home_picks" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"because_artist_id" uuid,
	"because_artist_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"top_artist_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"rediscover" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hourly" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mixes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"artist_ids" uuid[] NOT NULL,
	"tracks" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "home_picks" ADD CONSTRAINT "home_picks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_picks" ADD CONSTRAINT "home_picks_because_artist_id_artists_id_fk" FOREIGN KEY ("because_artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mixes" ADD CONSTRAINT "mixes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mixes_user_position" ON "mixes" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "plays_user_completed" ON "plays" USING btree ("user_id","started_at","recording_id","album_id") WHERE completed and not skipped;