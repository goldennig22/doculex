ALTER TABLE "decision_citations" DROP CONSTRAINT "decision_citations_confidence_range";--> statement-breakpoint
ALTER TABLE "decision_citations" DROP CONSTRAINT "decision_citations_statute_document_id_documents_id_fk";
--> statement-breakpoint
DROP INDEX "decision_citations_article";--> statement-breakpoint
ALTER TABLE "decision_citations" DROP COLUMN "statute_document_id";--> statement-breakpoint
ALTER TABLE "decision_citations" DROP COLUMN "confidence";--> statement-breakpoint
CREATE TYPE "public"."citation_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."citation_method" AS ENUM('rule', 'llm', 'reviewer');--> statement-breakpoint
ALTER TABLE "decision_citations" ALTER COLUMN "article_ref" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "chunk_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "act_code" text;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "act_version" text;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "act_source" text;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "version_hint" text;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "method" "citation_method" NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "confidence" "citation_confidence" NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "act_code" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "act_version" text;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD CONSTRAINT "decision_citations_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_citations_article" ON "decision_citations" USING btree ("act_code","act_version","article_ref");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_act_version_language" UNIQUE("act_code","act_version","language");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_act_code_and_version" CHECK (("documents"."act_code" IS NULL) = ("documents"."act_version" IS NULL));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_act_statute_only" CHECK ("documents"."act_code" IS NULL OR "documents"."kind" = 'statute');