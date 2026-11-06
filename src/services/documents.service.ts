import { extractText } from "unpdf";
import { db } from "../db/client";
import { chunks, documents } from "../db/schema";
import { UploadDocumentInput } from "../interfaces/documents";
import { chunkByArticle, embeddingText } from "./chunker.service";
import { eq, sql } from "drizzle-orm";
import { embedDocuments } from "./embeddings.service";
import { env } from "../config/env";

const refreshLexemeStats = () => db.execute(sql`REFRESH MATERIALIZED VIEW lexeme_stats`);

export const ingestDocument = async (input: UploadDocumentInput) => {
  const { totalPages, text } = await extractText(new Uint8Array(input.file), { mergePages: false });
  const pages = text.map((t, i) => ({ page: i + 1, text: t }));
  const drafts = chunkByArticle(pages);
  const embeddings = await embedDocuments(drafts.map(embeddingText));   // section path + content

  const result = await db.transaction(async (tx) => {
    const [doc] = await tx.insert(documents)
      .values({ title: input.title, language: input.language, sourceUrl: input.sourceUrl, pageCount: totalPages })
      .returning({ id: documents.id });
    if (drafts.length) {
      await tx.insert(chunks).values(drafts.map((c, i) => ({
        ...c, documentId: doc.id, lang: input.language,
        embedding: embeddings[i], embeddingModel: env.EMBEDDING_MODEL,
      })));
    }
    return { documentId: doc.id, chunkCount: drafts.length };
  });

  await refreshLexemeStats();   // AFTER the commit, so it sees the new chunks
  return result;
};

export const getDocuments = async (id?: string) => {
    let data = null;  
    if (id) {
        const response = await db.select().from(documents).where(eq(documents.id, id));
        if (response.length > 0) {
            data =  response[0];
        }
    } else {
        data = await db.select().from(documents);
    }
    return data;
}

export const deleteDocument = async (id: string) => {
  await db.delete(chunks).where(eq(chunks.documentId, id));
  await db.delete(documents).where(eq(documents.id, id));
  await refreshLexemeStats();
};