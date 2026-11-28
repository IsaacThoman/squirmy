CREATE TABLE "playlist_collaborators" (
	"playlist_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"can_edit" boolean NOT NULL,
	CONSTRAINT "playlist_collaborators_playlist_id_user_id_pk" PRIMARY KEY("playlist_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "playlist_folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "artwork_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "playlist_collaborators" ADD CONSTRAINT "playlist_collaborators_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_collaborators" ADD CONSTRAINT "playlist_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_folders" ADD CONSTRAINT "playlist_folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlist_collaborators_user" ON "playlist_collaborators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "playlist_folders_owner" ON "playlist_folders" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_folder_id_playlist_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."playlist_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_artwork_asset_id_assets_id_fk" FOREIGN KEY ("artwork_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlists_folder" ON "playlists" USING btree ("folder_id");