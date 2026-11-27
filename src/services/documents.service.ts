import { extractText } from "unpdf";
import { db } from "../db/client";
import { chunks, documents } from "../db/schema";
import { PageText, UploadDocumentInput } from "../interfaces/types";
import { chunkByArticle, embeddingText } from "./chunker.service";
import { and, eq, sql } from "drizzle-orm";
import { embedDocuments } from "./embeddings.service";
import { env } from "../config/env";
import { searchableDocuments } from "./search.service";
import { HttpError } from "../utils/http-error";
import type { ActCode } from "./citations/acts";
import { regradeAllCitations } from "./citations/citations.service";

export const refreshLexemeStats = () => db.execute(sql`REFRESH MATERIALIZED VIEW lexeme_stats`);

/** The text of each page of a PDF, numbered from 1. */
export const extractPages = async (file: Buffer): Promise<{ totalPages: number; pages: PageText[] }> => {
  const { totalPages, text } = await extractText(new Uint8Array(file), { mergePages: false });
  return { totalPages, pages: text.map((t, i) => ({ page: i + 1, text: t })) };
};

/** Sets which act version a statute holds (npm run documents:set-act). false when no statute has this id. */
export const setDocumentAct = async (id: string, actCode: ActCode, actVersion: string): Promise<boolean> => {
  const updated = await db.update(documents).set({ actCode, actVersion })
    .where(and(eq(documents.id, id), eq(documents.kind, 'statute'))).returning({ id: documents.id });
  return updated.length > 0;
};

export const ingestDocument = async (input: UploadDocumentInput) => {
  // Before the embeddings are paid for. A concurrent upload can still pass this; the UNIQUE constraint stops it (500).
  const [taken] = await db.select({ id: documents.id }).from(documents).where(and(
    eq(documents.actCode, input.actCode), eq(documents.actVersion, input.actVersion), eq(documents.language, input.language)));
  if (taken) throw new HttpError(409, `A document already holds ${input.actCode} ${input.actVersion} in this language: ${taken.id}`);
  const { totalPages, pages } = await extractPages(input.file);
  const drafts = chunkByArticle(pages);
  const embeddings = await embedDocuments(drafts.map(embeddingText));   // section path + content

  const result = await db.transaction(async (tx) => {
    const [doc] = await tx.insert(documents)
      .values({
        title: input.title, language: input.language, sourceUrl: input.sourceUrl, pageCount: totalPages,
        actCode: input.actCode, actVersion: input.actVersion,
      })
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
  // Citations waiting for this version ("version_not_ingested") are graded again, and now link to its articles.
  // If this throws, the document is stored: `npm run documents:set-act` with the same act and version repairs it.
  await regradeAllCitations();
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