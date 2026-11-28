CREATE TABLE "version_picks" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"picked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "version_picks_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "disambiguation" text;--> statement-breakpoint
ALTER TABLE "version_picks" ADD CONSTRAINT "version_picks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "version_picks" ADD CONSTRAINT "version_picks_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "version_picks_entity" ON "version_picks" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "version_picks_release" ON "version_picks" USING btree ("release_id");