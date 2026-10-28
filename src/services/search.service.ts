import { cosineDistance, eq, isNotNull, sql } from "drizzle-orm";
import { embedQuery } from "./embeddings.service";
import { chunks, documents } from "../db/schema";
import { db } from "../db/client";

export async function searchByVector(question: string, k = 8) {
  const q = await embedQuery(question);
  const distance = cosineDistance(chunks.embedding, q);

  return db
    .select({
      id: chunks.id,
      articleRef: chunks.articleRef,
      pageStart: chunks.pageStart,
      content: chunks.content,
      similarity: sql<number>`1 - (${distance})`,
      documentTitle: documents.title
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(isNotNull(chunks.embedding))
    .orderBy(distance)   // ascending DISTANCE, so Postgres can use the HNSW index
    .limit(k);
}