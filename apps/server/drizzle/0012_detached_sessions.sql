CREATE TABLE "detached_sessions" (
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"queue_version" bigint DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "detached_sessions_user_id_device_id_pk" PRIMARY KEY("user_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "detached_sessions" ADD CONSTRAINT "detached_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detached_sessions" ADD CONSTRAINT "detached_sessions_user_id_device_id_devices_user_id_id_fk" FOREIGN KEY ("user_id","device_id") REFERENCES "public"."devices"("user_id","id") ON DELETE cascade ON UPDATE no action;