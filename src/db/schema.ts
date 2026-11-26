import { sql } from 'drizzle-orm';
import { unique, check } from 'drizzle-orm/pg-core';
import { boolean } from 'drizzle-orm/pg-core';
import { date } from 'drizzle-orm/pg-core';
import { real } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';
import { index } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';
import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const documentKind = pgEnum('document_kind', ['statute', 'decision']);
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

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
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  part: integer('part').notNull().default(0),
  articleRef: text('article_ref').notNull(),
  pageStart: integer('page_start').notNull(),
  pageEnd: integer('page_end').notNull(),
  lang: text('lang').notNull().default('fr'),
  content: text('content').notNull(),
  sectionPath: text('section_path'),
  tokenCount: integer('token_count'),
  embedding: vector('embedding', { dimensions: 1536 }),   // nullable: filled after insert
  embeddingModel: text('embedding_model'),
  contentTsv: tsvector('content_tsv').generatedAlwaysAs(sql`to_tsvector(
  CASE WHEN lang = 'en' THEN 'english'::regconfig ELSE 'french'::regconfig END,
  coalesce(section_path, '') || ' ' || content)`),
},(t) => [
  unique('chunks_doc_article_part').on(t.documentId, t.articleRef, t.part),
  index('chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  index('chunks_content_tsv_gin').using('gin', t.contentTsv),
])

export const queries = pgTable('queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  question: text('question').notNull(),
  language: text('language').notNull(),
  found: boolean('found').notNull(),
  stoppedAt: text('stopped_at'),            // 'threshold' | 'llm' | 'no_valid_citation' | 'error' | null (answered)
  topSimilarity: real('top_similarity'),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: real('cost_usd'),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Phase 2: API keys with roles, court decisions ──────────────────────────

export const apiKeyRole = pgEnum('api_key_role', ['admin', 'reviewer', 'contributor']);

// The key itself is never stored: only its SHA-256 (see api-keys.service.ts).
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  keyHash: text('key_hash').notNull().unique(),
  prefix: text('prefix').notNull(),               // "dlx_Q3vA": tells keys apart in a listing, useless to an attacker
  role: apiKeyRole('role').notNull(),             // no default: every key gets its role on purpose
  label: text('label').notNull(),                 // who holds it, e.g. "law-clinic-reviewer-1"
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const decisionStatus = pgEnum('decision_status', ['draft', 'in_review', 'published', 'rejected']);
export const generatedBy = pgEnum('generated_by', ['ai', 'reviewer']);
// One row per document of kind 'decision'. Its text lives in chunks, like a statute's.
// Only 'published' decisions are searchable: see `searchable` in search.service.ts.
export const decisions = pgTable('decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().unique().references(() => documents.id, { onDelete: 'cascade' }),
  // Nullable while in draft: a contributor may not know them, AI extraction fills them later.
  // The CHECK below requires court and date before publication.
  court: text('court'),                           // "CCJA", "Cour suprême du Cameroun"
  country: text('country'),                       // ISO 3166-1 alpha-2 ("CM", "CI"); null for the CCJA
  chamber: text('chamber'),
  caseNumber: text('case_number'),                // "Arrêt n° 045/2019"
  decisionDate: date('decision_date'),            // 'YYYY-MM-DD' string in TypeScript
  subject: text('subject'),
  outcome: text('outcome'),                       // "cassation", "rejet", "irrecevabilité"
  headnote: text('headnote'),
  generatedBy: generatedBy('generated_by').notNull().default('reviewer'), // who wrote the metadata
  status: decisionStatus('status').notNull().default('draft'),
  sourceName: text('source_name').notNull(),      // "Ohadata", "greffe de la CCJA"
  sourceUrl: text('source_url'),
  contributedBy: uuid('contributed_by').notNull().references(() => apiKeys.id),
  reviewedBy: uuid('reviewed_by').references(() => apiKeys.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('decisions_status').on(t.status),
  // A decision can't be published half-filled or unreviewed, whatever the application code does
  check('decisions_published_complete', sql`${t.status} <> 'published' OR (
    ${t.publishedAt} IS NOT NULL AND ${t.reviewedBy} IS NOT NULL
    AND ${t.court} IS NOT NULL AND ${t.decisionDate} IS NOT NULL)`),
  // Four eyes: nobody reviews their own upload
  check('decisions_reviewer_not_contributor', sql`${t.reviewedBy} IS DISTINCT FROM ${t.contributedBy}`),
]);

// An article a decision cites, as (statute document, article ref): the key getArticleParts already uses.
// A chunk id would break when the statute is re-ingested (its chunks are recreated) and differs for each part.
export const decisionCitations = pgTable('decision_citations', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'cascade' }),
  // SET NULL: deleting a statute keeps the citation (raw_text), so it can be linked again
  statuteDocumentId: uuid('statute_document_id').references(() => documents.id, { onDelete: 'set null' }),
  articleRef: text('article_ref'),                // "7", "12 bis": same format as chunks.article_ref
  rawText: text('raw_text').notNull(),            // as written in the decision: "l'article 7 de l'AUDCG"
  confidence: real('confidence'),                 // 0..1 from AI extraction; null when a reviewer entered it
}, (t) => [
  index('decision_citations_decision').on(t.decisionId),
  index('decision_citations_article').on(t.statuteDocumentId, t.articleRef),
  check('decision_citations_confidence_range',
    sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`),
]);
