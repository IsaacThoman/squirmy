ALTER TABLE "albums" ADD COLUMN "edition_of_id" uuid;--> statement-breakpoint
CREATE INDEX "albums_edition_of" ON "albums" USING btree ("edition_of_id") WHERE "albums"."edition_of_id" is not null;