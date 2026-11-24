import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { queries } from "../db/schema";
import { UserQuery } from "../interfaces/types";

export async function storeQuery(body: UserQuery) {
    const [query] = await db.insert(queries)
        .values({ ...body })
        .returning({ id: queries.id });
    
    
    return query.id;
}

export async function getQuery(id: string) {
    const [query] = await db.select()
    .from(queries)
    .where(
        eq(queries.id, id)
    );

    return query;
}