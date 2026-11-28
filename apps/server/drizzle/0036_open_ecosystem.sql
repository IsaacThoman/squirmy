CREATE TABLE "scrobble_hearts" (
	"user_id" uuid NOT NULL,
	"connection" text NOT NULL,
	"recording_id" uuid NOT NULL,
	"remote_at" timestamp with time zone,
	"exported_heart_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	CONSTRAINT "scrobble_hearts_user_id_connection_recording_id_pk" PRIMARY KEY("user_id","connection","recording_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"http_status" integer,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret_encrypted" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_passwords" ADD COLUMN "scopes" text[];--> statement-breakpoint
ALTER TABLE "app_passwords" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "likes" ADD COLUMN "imported_heart" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scrobble_hearts" ADD CONSTRAINT "scrobble_hearts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrobble_hearts" ADD CONSTRAINT "scrobble_hearts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event" ON "webhook_deliveries" USING btree ("webhook_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_recent" ON "webhook_deliveries" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "webhooks_user" ON "webhooks" USING btree ("user_id");