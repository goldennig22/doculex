import { eq, isNull } from "drizzle-orm"
import { db } from "../db/client"
import { chunks } from "../db/schema"
import { embedDocuments } from '../services/embeddings.service';
import { env } from "../config/env";

const embedMissing = async () => {
    const retrievedChunks = await db.select({ id: chunks.id, content: chunks.content })
    .from(chunks)
    .where(isNull(chunks.embedding));

    retrievedChunks.map(async (chunk) => {
        const embedding = await embedDocuments([chunk.content]);
        await db.update(chunks).set({
            embedding: embedding[0],
            embeddingModel: env.EMBEDDING_MODEL
        }).where(eq(chunks.id, chunk.id));
    })
}

embedMissing()