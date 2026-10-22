import { extractText } from "unpdf";
import { db } from "../db/client";
import { chunks, documents } from "../db/schema";
import { Chunk, PageText, UploadDocumentInput } from "../interfaces/documents";
import { chunkByArticle } from "./chunker.service";
import { eq } from "drizzle-orm";

export const ingestDocument = async (input: UploadDocumentInput) => {
    const { totalPages, text } = await extractText(new Uint8Array(input.file), { mergePages: false });
    const pages = text.map((t, i) => ({ page: i + 1, text: t }));
    const drafts = chunkByArticle(pages);            // ← yours

    return db.transaction(async (tx) => {
        const [doc] = await tx.insert(documents)
        .values({ title: input.title, language: input.language, sourceUrl: input.sourceUrl, pageCount: totalPages })
        .returning({ id: documents.id });
        if (drafts.length) {
        await tx.insert(chunks).values(drafts.map((c) => ({ ...c, documentId: doc.id, lang: input.language })));
        }
        const document = await getDocuments(doc.id);
        return { document, chunkCount: drafts.length };
    });
}

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
    await db.delete(chunks).where(eq(chunks.documentId, id))
    await db.delete(documents).where(eq(documents.id, id))
}