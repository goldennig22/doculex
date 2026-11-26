CREATE TYPE "public"."api_key_role" AS ENUM('admin', 'reviewer', 'contributor');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('draft', 'in_review', 'published', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."generated_by" AS ENUM('ai', 'reviewer');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"role" "api_key_role" NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "decision_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"statute_document_id" uuid,
	"article_ref" text,
	"raw_text" text NOT NULL,
	"confidence" real,
	CONSTRAINT "decision_citations_confidence_range" CHECK ("decision_citations"."confidence" IS NULL OR ("decision_citations"."confidence" >= 0 AND "decision_citations"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"court" text,
	"country" text,
	"chamber" text,
	"case_number" text,
	"decision_date" date,
	"subject" text,
	"outcome" text,
	"headnote" text,
	"generated_by" "generated_by" DEFAULT 'reviewer' NOT NULL,
	"status" "decision_status" DEFAULT 'draft' NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"contributed_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_document_id_unique" UNIQUE("document_id"),
	CONSTRAINT "decisions_published_complete" CHECK ("decisions"."status" <> 'published' OR (
    "decisions"."published_at" IS NOT NULL AND "decisions"."reviewed_by" IS NOT NULL
    AND "decisions"."court" IS NOT NULL AND "decisions"."decision_date" IS NOT NULL)),
	CONSTRAINT "decisions_reviewer_not_contributor" CHECK ("decisions"."reviewed_by" IS DISTINCT FROM "decisions"."contributed_by")
);
--> statement-breakpoint
ALTER TABLE "decision_citations" ADD CONSTRAINT "decision_citations_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD CONSTRAINT "decision_citations_statute_document_id_documents_id_fk" FOREIGN KEY ("statute_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_contributed_by_api_keys_id_fk" FOREIGN KEY ("contributed_by") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_reviewed_by_api_keys_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_citations_decision" ON "decision_citations" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "decision_citations_article" ON "decision_citations" USING btree ("statute_document_id","article_ref");--> statement-breakpoint
CREATE INDEX "decisions_status" ON "decisions" USING btree ("status");