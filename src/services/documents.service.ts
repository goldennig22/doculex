import { extractText } from "unpdf";
import { db } from "../db/client";
import { chunks, documents } from "../db/schema";
import { PageText, UploadDocumentInput } from "../interfaces/types";
import { chunkByArticle, embeddingText } from "./chunker.service";
import { and, eq, sql } from "drizzle-orm";
import { embedDocuments } from "./embeddings.service";
import { env } from "../config/env";
import { searchableDocuments } from "./search.service";

export const refreshLexemeStats = () => db.execute(sql`REFRESH MATERIALIZED VIEW lexeme_stats`);

/** The text of each page of a PDF, numbered from 1. */
export const extractPages = async (file: Buffer): Promise<{ totalPages: number; pages: PageText[] }> => {
  const { totalPages, text } = await extractText(new Uint8Array(file), { mergePages: false });
  return { totalPages, pages: text.map((t, i) => ({ page: i + 1, text: t })) };
};

export const ingestDocument = async (input: UploadDocumentInput) => {
  const { totalPages, pages } = await extractPages(input.file);
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

/**
 * Public listing: statutes and published decisions only. A draft decision's title names the parties,
 * and a draft's id answers 404, not 403: a 403 would confirm that it exists.
 */
export const getDocuments = async (id?: string) => {
    const visible = searchableDocuments(['statute', 'decision']);
    let data = null;
    if (id) {
        const response = await db.select().from(documents).where(and(eq(documents.id, id), visible));
        if (response.length > 0) {
            data =  response[0];
        }
    } else {
        data = await db.select().from(documents).where(visible);
    }
    return data;
}

/** false when no document has this id. Its chunks go with it (ON DELETE CASCADE), in the same statement. */
export const deleteDocument = async (id: string): Promise<boolean> => {
  const deleted = await db.delete(documents).where(eq(documents.id, id)).returning({ id: documents.id });
  if (deleted.length === 0) return false;
  await refreshLexemeStats();
  return true;
};