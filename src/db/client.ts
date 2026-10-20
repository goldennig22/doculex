import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from '../config/env';

export const sql = postgres(env.DATABASE_URL, { max: 10 }); // connects lazily, on the first query
export const db = drizzle(sql);