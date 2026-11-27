CREATE TYPE "public"."anonymisation_status" AS ENUM('pending', 'done', 'needs_manual_review');--> statement-breakpoint
CREATE TYPE "public"."mention_source" AS ENUM('rule', 'llm', 'both', 'reviewer');--> statement-breakpoint
CREATE TABLE "name_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"chunk_id" uuid,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"placeholder" text NOT NULL,
	"original_hash" text NOT NULL,
	"original_text" text,
	"source" "mention_source" NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	CONSTRAINT "name_mentions_confirmed_no_clear" CHECK (NOT "name_mentions"."confirmed" OR "name_mentions"."original_text" IS NULL),
	CONSTRAINT "name_mentions_span" CHECK ("name_mentions"."start" >= 0 AND "name_mentions"."end" > "name_mentions"."start")
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "anonymisation_status" "anonymisation_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "name_mentions" ADD CONSTRAINT "name_mentions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_mentions" ADD CONSTRAINT "name_mentions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "name_mentions" ADD CONSTRAINT "name_mentions_confirmed_by_api_keys_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "name_mentions_decision" ON "name_mentions" USING btree ("decision_id");--> statement-breakpoint
-- Decisions uploaded before this migration never got a detection job: 'pending' would be a lie, and 'done' a worse one.
-- A decision already 'published' makes the CHECK below fail, and the migration with it, on purpose: it was published
-- without anonymisation. Unpublish it (status 'in_review') by hand first.
UPDATE "decisions" SET "anonymisation_status" = 'needs_manual_review';--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_published_anonymised" CHECK ("decisions"."status" <> 'published' OR "decisions"."anonymisation_status" = 'done');