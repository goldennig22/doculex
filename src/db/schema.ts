import { sql } from 'drizzle-orm';
import { unique, check } from 'drizzle-orm/pg-core';
import { boolean } from 'drizzle-orm/pg-core';
import { date } from 'drizzle-orm/pg-core';
import { real } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';
import { index } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';
import { pgTable, uuid, text, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import type { ActCode } from '../services/citations/acts';
import type { ActSource } from '../services/citations/detector';
import type { LinkReason } from '../services/citations/grading';

export const documentKind = pgEnum('document_kind', ['statute', 'decision']);
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: documentKind('kind').notNull().default('statute'),
  title: text('title').notNull(),
  language: text('language').notNull(),          // 'fr' | 'en'
  sourceUrl: text('source_url'),
  pageCount: integer('page_count').notNull().default(0),
  // Which act version a statute holds ("AUDCG", "2010"): what decision citations link to (see decisionCitations).
  // Codes and versions are listed in src/services/citations/acts.ts.
  actCode: text('act_code').$type<ActCode>(),
  actVersion: text('act_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One document per act version and language: the French and the English AUSCGIE 1997 can both exist
  unique('documents_act_version_language').on(t.actCode, t.actVersion, t.language),
  check('documents_act_code_and_version', sql`(${t.actCode} IS NULL) = (${t.actVersion} IS NULL)`),
  check('documents_act_statute_only', sql`${t.actCode} IS NULL OR ${t.kind} = 'statute'`),
]);

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
// AI metadata extraction, run by the extract-decision job (src/jobs). 'needs_manual_entry': the model's output
// was unusable or every retry failed, so a person types the fields.
export const extractionStatus = pgEnum('extraction_status', ['pending', 'done', 'needs_manual_entry']);
// Normalised across languages ("appeal dismissed" is 'rejet'), so case-law search can filter on it
export const decisionOutcome = pgEnum('decision_outcome', [
  'cassation', 'cassation_partielle', 'rejet', 'irrecevabilite', 'incompetence', 'autre',
]);
// Detection of natural persons' names, run by the anonymise-decision job. 'needs_manual_review': the LLM pass
// failed or its output was unusable, so only the rules ran; a reviewer must read the whole text before publishing.
export const anonymisationStatus = pgEnum('anonymisation_status', ['pending', 'done', 'needs_manual_review']);

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
  outcome: decisionOutcome('outcome'),
  headnote: text('headnote'),                     // 3 sentences, in the decision's language
  // The text before "a rendu l'Arrêt suivant": court, case number, date, but also party names.
  // Never chunked or searchable. The anonymisation job replaces the names in it like in any chunk (it lists the
  // parties, so it is the best input for detection); set to NULL when a reviewer publishes or rejects (CHECK below).
  captionText: text('caption_text'),
  extractionStatus: extractionStatus('extraction_status').notNull().default('pending'),
  extractionError: text('extraction_error'),      // why it needs manual entry
  anonymisationStatus: anonymisationStatus('anonymisation_status').notNull().default('pending'),
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
  // Search over published decisions (decision-search.service.ts). Partial: drafts are never searched, so they have
  // no reason to be in these indexes, and the query states `status = 'published'` literally so the planner can use them.
  // Each one ends with the date: a filter on court or country still reads its rows already sorted newest first.
  index('decisions_published_date').on(t.decisionDate.desc(), t.id).where(sql`${t.status} = 'published'`),
  index('decisions_published_court').on(t.court, t.decisionDate.desc()).where(sql`${t.status} = 'published'`),
  index('decisions_published_country').on(t.country, t.decisionDate.desc()).where(sql`${t.status} = 'published'`),
  // A decision can't be published half-filled or unreviewed, whatever the application code does
  check('decisions_published_complete', sql`${t.status} <> 'published' OR (
    ${t.publishedAt} IS NOT NULL AND ${t.reviewedBy} IS NOT NULL
    AND ${t.court} IS NOT NULL AND ${t.decisionDate} IS NOT NULL)`),
  // Party names in the caption never outlive publication
  check('decisions_published_no_caption', sql`${t.status} <> 'published' OR ${t.captionText} IS NULL`),
  // Four eyes: nobody reviews their own upload
  check('decisions_reviewer_not_contributor', sql`${t.reviewedBy} IS DISTINCT FROM ${t.contributedBy}`),
  // Zero mentions before detection ran would look like "nothing left to confirm": never publish undetected text
  check('decisions_published_anonymised', sql`${t.status} <> 'published' OR ${t.anonymisationStatus} = 'done'`),
]);

export const mentionSource = pgEnum('mention_source', ['rule', 'llm', 'both', 'reviewer']);

// One row per occurrence of a natural person's name that was replaced by a placeholder ("M. X").
// The chunk (or caption) text holds the placeholder from the moment detection runs; the clear name lives only
// in original_text, and only until a reviewer confirms the mention. original_hash (HMAC, see anonymisation/names.ts)
// stays: the publish-time leak check looks for it in every published field.
export const nameMentions = pgTable('name_mentions', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'cascade' }),
  chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'cascade' }), // null: the caption
  // UTF-16 offsets of the PLACEHOLDER in the current text, end excluded. They move when an earlier mention of the
  // same text is edited: replaceSpan in anonymisation/mentions.ts is the only code that changes such a text.
  start: integer('start').notNull(),
  end: integer('end').notNull(),
  placeholder: text('placeholder').notNull(),    // "X": the same person has the same letter everywhere in one decision
  originalHash: text('original_hash').notNull(),
  originalText: text('original_text'),           // the clear name, while confirmed = false only
  source: mentionSource('source').notNull(),     // rule, llm, both (the reviewer checks 'llm' and 'rule' first), reviewer
  confirmed: boolean('confirmed').notNull().default(false),
  confirmedBy: uuid('confirmed_by').references(() => apiKeys.id),
}, (t) => [
  index('name_mentions_decision').on(t.decisionId),
  check('name_mentions_confirmed_no_clear', sql`NOT ${t.confirmed} OR ${t.originalText} IS NULL`),
  check('name_mentions_span', sql`${t.start} >= 0 AND ${t.end} > ${t.start}`),
]);

export const citationMethod = pgEnum('citation_method', ['rule', 'llm', 'reviewer']);
export const citationConfidence = pgEnum('citation_confidence', ['high', 'medium', 'low']);

// An article a decision cites, as its legal identity (act, version, article ref), filled by the link-citations job.
// Not a statute document id: article numbers belong to a VERSION of an act (AUDCG 1997 and 2010 number leases
// differently), and a document id dies when a statute is deleted and uploaded again. Not a chunk id either: chunks
// are recreated on re-ingest and differ for each part. The article page joins documents on (act_code, act_version).
// One row per MENTION, not per cited article: Avis n° 002/2015 names AUSCGIE art. 908 ten times, so ten rows. Readers
// that want "which articles does this decision cite" must GROUP BY or SELECT DISTINCT (decision_id, act_code,
// act_version, article_ref). No UNIQUE on that tuple on purpose: each mention keeps its own raw_text and chunk.
export const decisionCitations = pgTable('decision_citations', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'cascade' }),
  // The decision's section the citation was found in; null when a reviewer added it
  chunkId: uuid('chunk_id').references(() => chunks.id, { onDelete: 'cascade' }),
  actCode: text('act_code').$type<ActCode>(),     // null: unresolved (confidence 'low', for review)
  actVersion: text('act_version'),                // null: not linkable (Code civil) or version unknown
  articleRef: text('article_ref').notNull(),      // "7", "12 bis": same format as chunks.article_ref
  rawText: text('raw_text').notNull(),            // as written in the decision: "l'article 7 de l'AUDCG"
  // What the rules saw, kept so the publish step can grade again once the decision date is final
  actSource: text('act_source').$type<Exclude<ActSource, null>>(),
  versionHint: text('version_hint'),
  method: citationMethod('method').notNull(),
  confidence: citationConfidence('confidence').notNull(),
  reason: text('reason').$type<LinkReason>(),     // see LinkReason in src/services/citations/grading.ts
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('decision_citations_decision').on(t.decisionId),
  index('decision_citations_article').on(t.actCode, t.actVersion, t.articleRef),
  // The search filter `act=AUDCG&article=7` without a version: the index above can't skip its middle column
  index('decision_citations_act_article').on(t.actCode, t.articleRef),
]);

// ─── Takedown: reports on published decisions ───────────────────────────────

export const reportReason = pgEnum('report_reason', ['personal_data', 'wrong_metadata', 'wrong_text', 'other']);

// One row per report (POST /api/decisions/:id/report, public). A 'personal_data' report takes the decision offline
// at once (published → in_review), unless the daily breaker is open: see decision-report.service.ts.
// message and contact are personal data of the reporter: never published, never sent to the notification service.
export const decisionReports = pgTable('decision_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  decisionId: uuid('decision_id').notNull().references(() => decisions.id, { onDelete: 'cascade' }),
  reason: reportReason('reason').notNull(),
  message: text('message'),
  contact: text('contact'),
  tookDown: boolean('took_down').notNull(),       // this report moved the decision back to in_review
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Set when a reviewer publishes the decision again or rejects it
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => apiKeys.id),
}, (t) => [
  index('decision_reports_decision').on(t.decisionId),
  // The breaker counts today's takedowns
  index('decision_reports_took_down').on(t.createdAt).where(sql`${t.tookDown}`),
  check('decision_reports_resolved', sql`(${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL)`),
]);
