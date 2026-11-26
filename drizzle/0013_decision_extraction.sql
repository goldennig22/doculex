CREATE TYPE "public"."decision_outcome" AS ENUM('cassation', 'cassation_partielle', 'rejet', 'irrecevabilite', 'incompetence', 'autre');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'done', 'needs_manual_entry');--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "outcome" SET DATA TYPE "public"."decision_outcome" USING "outcome"::"public"."decision_outcome";--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "caption_text" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "extraction_status" "extraction_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "extraction_error" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_published_no_caption" CHECK ("decisions"."status" <> 'published' OR "decisions"."caption_text" IS NULL);--> statement-breakpoint
-- Decisions uploaded before this migration never got an extraction job: 'pending' would be a lie
UPDATE "decisions" SET "extraction_status" = 'needs_manual_entry', "extraction_error" = 'Uploaded before AI extraction existed';
