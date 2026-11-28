CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"album_id" uuid,
	"playlist_id" uuid,
	"recording_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"last_opened_at" timestamp with time zone,
	CONSTRAINT "shares_target" CHECK (case "shares"."kind" when 'album' then "shares"."album_id" is not null and "shares"."playlist_id" is null and "shares"."recording_id" is null
    when 'playlist' then "shares"."playlist_id" is not null and "shares"."album_id" is null and "shares"."recording_id" is null
    when 'track' then "shares"."recording_id" is not null and "shares"."playlist_id" is null
    else false end)
);
--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shares_token_hash" ON "shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "shares_user" ON "shares" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "shares_created" ON "shares" USING btree ("created_at");