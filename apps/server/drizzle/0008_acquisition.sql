CREATE TABLE "acquisition_offers" (
	"provider_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"offers" jsonb NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acquisition_offers_provider_id_recording_id_pk" PRIMARY KEY("provider_id","recording_id")
);
--> statement-breakpoint
ALTER TABLE "acquisition_jobs" ADD COLUMN "recording_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "acquisition_offers" ADD CONSTRAINT "acquisition_offers_provider_id_acquisition_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."acquisition_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquisition_offers" ADD CONSTRAINT "acquisition_offers_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquisition_offers_recording" ON "acquisition_offers" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "acquisition_misses_entity" ON "acquisition_misses" USING btree ("entity_id");