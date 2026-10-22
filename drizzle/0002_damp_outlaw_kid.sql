CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"part" integer DEFAULT 0 NOT NULL,
	"article_ref" text NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"lang" text DEFAULT 'fr' NOT NULL,
	"content" text NOT NULL,
	"token_count" integer
);
