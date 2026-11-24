CREATE TABLE "collection_plays" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_plays_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "collection_plays" ADD CONSTRAINT "collection_plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_plays_user_recent" ON "collection_plays" USING btree ("user_id","played_at" DESC NULLS LAST,"entity_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collection_plays_entity" ON "collection_plays" USING btree ("entity_type","entity_id");