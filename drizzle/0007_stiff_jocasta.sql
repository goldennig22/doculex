ALTER TABLE "chunks" ADD COLUMN "content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector(
  CASE WHEN lang = 'en' THEN 'english'::regconfig ELSE 'french'::regconfig END,
  coalesce(section_path, '') || ' ' || content)) STORED;--> statement-breakpoint
CREATE INDEX "chunks_content_tsv_gin" ON "chunks" USING gin ("content_tsv");