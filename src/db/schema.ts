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

export const chunks = pgTable('chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull(),
  part: integer('part').notNull().default(0),
  articleRef: text('article_ref').notNull(),
  pageStart: integer('page_start').notNull(),
  pageEnd: integer('page_end').notNull(),
  lang: text('lang').notNull().default('fr'),
  content: text('content').notNull(),
  tokenCount: integer('token_count'),
})