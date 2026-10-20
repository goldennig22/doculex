import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const documentKind = pgEnum('document_kind', ['statute', 'decision']);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: documentKind('kind').notNull().default('statute'),
  title: text('title').notNull(),
  language: text('language').notNull(),          // 'fr' | 'en'
  sourceUrl: text('source_url'),
  pageCount: integer('page_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});