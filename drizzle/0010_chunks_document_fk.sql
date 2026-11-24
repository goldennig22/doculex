-- Chunks whose document no longer exists (left by earlier deletes or failed ingests) would make ADD CONSTRAINT fail.
DELETE FROM "chunks" c WHERE NOT EXISTS (SELECT 1 FROM "documents" d WHERE d."id" = c."document_id");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
