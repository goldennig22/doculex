CREATE TYPE "public"."document_kind" AS ENUM('statute', 'decision');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "document_kind" DEFAULT 'statute' NOT NULL,
	"title" text NOT NULL,
	"language" text NOT NULL,
	"source_url" text,
	"page_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
