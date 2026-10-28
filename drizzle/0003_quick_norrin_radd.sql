ALTER TABLE "chunks" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "embedding_model" text;