// Route schemas: what each route accepts and returns. Fastify validates requests and checks responses with them
// (src/utils/zod-fastify.ts), and @fastify/swagger turns them into the OpenAPI document served at /docs.
// Examples use real data from the two ingested Acts.
import { z } from 'zod';
import {
  articlePageSchema, articleParamsSchema,
  askResponseSchema, createDecisionSchema, decisionIdSchema, decisionSchema, documentIdSchema, documentSchema,
  decisionSearchPageSchema, decisionSearchQuerySchema, decisionStatsSchema,
  reportDecisionSchema, reportReceivedSchema, reviewPatchSchema, reviewQueueItemSchema, reviewViewSchema, searchAllQuerySchema, searchItemSchema, searchQuestionSchema, uploadDocumentSchema,
} from '../../utils/schemas';

// ── Envelopes: every response is { status: 'success', data } or { status: 'failed', message, ... } ──

const success = <T extends z.ZodType>(data: T) => z.object({ status: z.literal('success'), data });

const failed = z.object({
  status: z.literal('failed'),
  message: z.string(),
  errors: z.record(z.string(), z.array(z.string()).optional()).optional()
    .describe('Validation errors by field (422 only)'),
  requestId: z.string().optional().describe('Matches the server log; on every error raised outside a controller'),
});

const failedExample = (message: string, extra: Record<string, unknown> = {}) =>
  failed.meta({ examples: [{ status: 'failed', message, ...extra, requestId: 'req-1a' }] });

const validationFailed = (field: string, issue: string) =>
  failedExample('Validation failed', { errors: { [field]: [issue] } });
const unauthorized = failed.meta({ examples: [{ status: 'failed', message: 'Invalid or missing API key' }] });
const serverError = failedExample('Internal server error');

const adminOnly = { security: [{ adminKey: [] }] };
const withApiKey = { security: [{ apiKey: [] }] };
const forbidden = (role: string) => failed.meta({ examples: [{ status: 'failed', message: `This action requires the ${role} role` }] });

// ── Example data ──

const AUDCG = 'Acte uniforme OHADA du 15 décembre 2010 portant sur le droit commercial généra';
const documentExample = {
  id: 'c9725d5d-0bc8-46aa-b8f8-cfa870d6425c', kind: 'statute', title: AUDCG, language: 'fr',
  sourceUrl: null, pageCount: 66, actCode: 'AUDCG', actVersion: '2010', createdAt: '2026-10-31T13:06:49.074Z',
};

// ── Routes ──

export const askSchema = {
  tags: ['ask'],
  summary: 'Ask a question about OHADA business law',
  description:
    'French or English. The answer cites the article and pages it comes from; every quote is verified word for word. '
    + 'When the Acts do not contain the answer, the response is 200 with `found: false`. '
    + 'Limited to 10 requests per minute per IP.',
  body: searchQuestionSchema.meta({
    'x-examples': {
      french: { summary: 'French question', value: { question: 'Un mineur non émancipé peut-il être commerçant ?' } },
      english: { summary: 'English question', value: { question: 'What is the maximum duration of a company?' } },
      outOfScope: { summary: 'Not covered by the Acts', value: { question: 'Quel est le taux normal de la TVA au Cameroun ?' } },
    },
  }),
  response: {
    200: success(askResponseSchema).meta({
      'x-examples': {
        answered: {
          summary: 'Answered, with a verified citation',
          value: {
            status: 'success',
            data: {
              found: true,
              answer: "Non. Le mineur, sauf s'il est émancipé, ne peut avoir la qualité de commerçant ni effectuer des actes de commerce (art. 7).",
              citations: [{
                document: AUDCG, article: '7', pages: [5, 5],
                quote: 'Le mineur, sauf s’il est émancipé, ne peut avoir la qualité de commerçant',
              }],
              confidence: 'high',
              language: 'fr',
            },
          },
        },
        notFound: {
          summary: 'found: false, the Acts do not contain the answer',
          value: {
            status: 'success',
            data: { found: false, answer: null, citations: [], confidence: null, language: 'fr' },
          },
        },
      },
    }),
    422: validationFailed('question', 'Too small: expected string to have >=3 characters'),
    429: failedExample('Rate limit exceeded, retry in 1 minute'),
    500: serverError,
  },
};

export const listDocumentsSchema = {
  tags: ['documents'],
  summary: 'List the ingested documents',
  response: { 200: success(z.array(documentSchema)).meta({ examples: [{ status: 'success', data: [documentExample] }] }) },
};

export const showDocumentSchema = {
  tags: ['documents'],
  summary: 'One document',
  params: documentIdSchema,
  response: {
    200: success(documentSchema).meta({ examples: [{ status: 'success', data: documentExample }] }),
    404: failed.meta({ examples: [{ status: 'failed', message: 'Document not found' }] }),
    422: validationFailed('documentId', 'Invalid UUID'),
  },
};

export const uploadDocumentRouteSchema = {
  tags: ['documents'],
  summary: 'Upload and ingest a PDF (admin)',
  description: 'Extracts the text, splits it article by article and embeds each article. PDF only (checked by its first bytes), 20 MB at most.',
  consumes: ['multipart/form-data'],
  ...adminOnly,
  body: uploadDocumentSchema,
  response: {
    201: success(documentSchema).meta({ examples: [{ status: 'success', data: documentExample }] }),
    401: unauthorized,
    403: forbidden('admin'),
    409: failedExample('A document already holds AUDCG 2010 in this language: c9725d5d-0bc8-46aa-b8f8-cfa870d6425c'),
    413: failedExample('Request file too large'),
    422: validationFailed('file', 'file must be a PDF'),
  },
};

export const deleteDocumentSchema = {
  tags: ['documents'],
  summary: 'Delete a document and its articles (admin)',
  ...adminOnly,
  params: documentIdSchema,
  response: {
    200: success(z.object({ documentId: z.uuid() })).meta({
      examples: [{ status: 'success', data: { documentId: documentExample.id } }],
    }),
    401: unauthorized,
    403: forbidden('admin'),
    404: failed.meta({ examples: [{ status: 'failed', message: 'Document not found' }] }),
    422: validationFailed('documentId', 'Invalid UUID'),
  },
};

const decisionExample = {
  id: '8d1f0c2e-4b7a-4e19-9c3d-5a6b7c8d9e0f', documentId: '2a9e7c41-6f3b-4d8a-b1c5-0e2f4a6b8c9d',
  title: 'CCJA, 1re ch., arrêt n° xxx/2019', language: 'fr', status: 'draft',
  court: 'CCJA', country: null, chamber: 'Première chambre', caseNumber: 'Arrêt n° xxx/2019', decisionDate: '2019-02-28',
  sourceName: 'Ohadata', sourceUrl: null, extractionStatus: 'pending', anonymisationStatus: 'pending', chunkCount: 6,
  createdAt: '2026-11-26T09:12:00.000Z',
};

export const createDecisionRouteSchema = {
  tags: ['decisions'],
  summary: 'Contribute a court decision (contributor key)',
  description:
    'A PDF (`file`) or plain text (`text`), never both, plus where it comes from. Stored as a **draft**: '
    + 'it is split by section (facts, each ground of appeal, operative part) and embedded, '
    + 'but no search returns it until a reviewer publishes it. Its metadata (court, date, case number, outcome, headnote) is then extracted by an LLM in the background: `extractionStatus` starts as `pending`. '
    + 'In parallel, the names of natural persons are detected and replaced by placeholders (`anonymisationStatus`); the decision then moves to `in_review`. 30 uploads per hour per IP.',
  consumes: ['multipart/form-data'],
  ...withApiKey,
  body: createDecisionSchema,
  response: {
    201: success(decisionSchema).meta({ examples: [{ status: 'success', data: decisionExample }] }),
    401: unauthorized,
    413: failedExample('Request file too large'),
    422: validationFailed('file', 'Send exactly one of file or text'),
    429: failedExample('Rate limit exceeded, retry in 1 hour'),
  },
};

// Invented names (not a real case): what a reviewer sees after detection, before confirming
const reviewExample = {
  ...decisionExample, status: 'in_review', anonymisationStatus: 'done', extractionStatus: 'done',
  subject: "Qualité de commerçant d'un mineur émancipé", outcome: 'rejet', headnote: 'Trois phrases.',
  caption: 'Affaire : Monsieur X (Conseil : Maître Y)\ncontre\nSociété Gamma SARL',
  sections: [{ ref: 'moyen-1', part: 0, text: "Attendu qu'il est fait grief à l'arrêt d'avoir retenu que « X, émancipé par jugement du 3 mars 2014, … » ;" }],
  unconfirmedMentions: 1, pendingEmbeddings: 0, publishedAt: null, openReports: 0,
  citations: [{
    id: '6a1d2c3b-4e5f-4a7b-8c9d-0e1f2a3b4c5d', segment: 'moyen-1', rawText: "l'article 49 de l'Acte uniforme portant organisation des procédures simplifiées de recouvrement",
    actCode: 'AUPSRVE', actVersion: '1998', articleRef: '49', method: 'rule', confidence: 'high', reason: null,
  }],
  mentions: [{
    id: '3f6c1a2b-9d8e-4f70-8a1b-2c3d4e5f6a7b', placeholder: 'X', segment: 'moyen-1', start: 61, end: 62,
    context: "il est fait grief à l'arrêt d'avoir retenu que « X, émancipé par jugement du 3 mars", original: 'TCHOUPO',
    source: 'llm', confirmed: false,
  }],
};
const reviewerOnly = forbidden('reviewer');
const decisionNotFound = failed.meta({ examples: [{ status: 'failed', message: 'Decision not found' }] });

export const showDecisionRouteSchema = {
  tags: ['decisions'],
  summary: 'A decision for review (reviewer key)',
  description: 'Metadata, the whole anonymised text, and every name mention with its context. '
    + '`original` holds the clear name until the mention is confirmed.',
  ...withApiKey,
  params: decisionIdSchema,
  response: {
    200: success(reviewViewSchema).meta({ examples: [{ status: 'success', data: reviewExample }] }),
    401: unauthorized,
    403: reviewerOnly,
    404: decisionNotFound,
    422: validationFailed('decisionId', 'Invalid UUID'),
  },
};

export const reviewDecisionRouteSchema = {
  tags: ['decisions'],
  summary: 'Review a decision: metadata and names (reviewer key)',
  description: 'All or nothing. Confirm each mention (`confirm`), put back one that is not a natural person (`not_a_person`), '
    + 'or move it to another person (`reassign`); add a name detection missed (`addMentions`: every occurrence is replaced). '
    + '`status`: `rejected`, or `in_review` after a failed detection. Not on your own upload (403). '
    + '409 for a published or rejected decision, and for any status move other than draft → in_review → published | rejected.',
  ...withApiKey,
  params: decisionIdSchema,
  body: reviewPatchSchema.meta({
    'x-examples': {
      confirm: { summary: 'Confirm two mentions, fix the headnote', value: {
        mentions: [{ id: '3f6c1a2b-9d8e-4f70-8a1b-2c3d4e5f6a7b', action: 'confirm' }],
        metadata: { headnote: 'La Cour était saisie… Elle relève… Elle rejette donc le pourvoi.' },
      } },
      missed: { summary: 'A name detection missed', value: { addMentions: [{ surface: 'FOTSO' }] } },
      reject: { summary: 'Reject', value: { status: 'rejected' } },
    },
  }),
  response: {
    200: success(reviewViewSchema).meta({ examples: [{ status: 'success', data: reviewExample }] }),
    401: unauthorized,
    403: reviewerOnly,
    404: decisionNotFound,
    409: failedExample("A decision can't go from published to in_review"),
    422: validationFailed('mentions', 'Invalid input'),
  },
};

export const publishDecisionRouteSchema = {
  tags: ['decisions'],
  summary: 'Publish a reviewed decision (reviewer key)',
  description: 'Refused (409) while detection has not run, any name mention is unconfirmed, court or date is missing, '
    + 'a section is being embedded again, or an anonymised name still appears in a published field (headnote, title…). '
    + 'Then the caption is erased and the decision becomes searchable. Not on your own upload (403).',
  ...withApiKey,
  params: decisionIdSchema,
  response: {
    200: success(reviewViewSchema).meta({ examples: [{ status: 'success', data: { ...reviewExample, status: 'published', caption: null } }] }),
    401: unauthorized,
    403: reviewerOnly,
    404: decisionNotFound,
    409: failedExample('2 name mention(s) are not confirmed yet'),
    422: validationFailed('decisionId', 'Invalid UUID'),
  },
};

export const reviewQueueRouteSchema = {
  tags: ['decisions'],
  summary: 'Decisions waiting for review (reviewer key)',
  description: 'In review, plus drafts whose name detection failed. Reported decisions first, then oldest first. '
    + '`ownUpload`: uploaded with your key, so someone else must review it.',
  ...withApiKey,
  response: {
    200: success(z.array(reviewQueueItemSchema)),
    401: unauthorized,
    403: reviewerOnly,
  },
};

export const reportDecisionRouteSchema = {
  tags: ['decisions'],
  summary: 'Report a published decision (no key)',
  description: 'A name left visible, wrong metadata or a wrong text. `personal_data` takes the decision offline at once, '
    + 'before anyone checks it; it comes back after a reviewer fixes and publishes it again. The other reasons are '
    + 'reviewed without taking it down. The message and contact are never published. '
    + 'The answer is the same 202 whatever happens. 404 for any decision that is not published. 5 reports per hour per IP.',
  params: decisionIdSchema,
  body: reportDecisionSchema.meta({
    'x-examples': {
      name: { summary: 'A name left visible', value: {
        reason: 'personal_data', message: 'Le nom du gérant apparaît en clair au moyen 1.',
      } },
      metadata: { summary: 'A wrong date', value: { reason: 'wrong_metadata', message: "L'arrêt date du 10 mai 2016, pas du 5 octobre." } },
    },
  }),
  response: {
    202: success(reportReceivedSchema).meta({ examples: [{ status: 'success', data: { reportId: '0b7e3c55-1f2a-4d6e-9a8b-7c6d5e4f3a2b' } }] }),
    404: decisionNotFound,
    413: failedExample('Request body is too large'),
    422: validationFailed('reason', 'Invalid option'),
    429: failedExample('Rate limit exceeded, retry in 1 hour'),
  },
};

const checkSchema = z.object({
  status: z.enum(['up', 'down']),
  latencyMs: z.number(),
  error: z.string().optional(),
});
const healthBody = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  checks: z.object({ database: checkSchema, llm: checkSchema }),
  uptimeS: z.number().int(),
});

export const healthSchema = {
  tags: ['health'],
  summary: 'Database and LLM provider status',
  description: '`degraded` when only the LLM provider is down; 503 when the database is down.',
  response: {
    200: healthBody.meta({
      examples: [{ status: 'ok', checks: { database: { status: 'up', latencyMs: 3 }, llm: { status: 'up', latencyMs: 180 } }, uptimeS: 86400 }],
    }),
    503: healthBody.meta({
      examples: [{ status: 'down', checks: { database: { status: 'down', latencyMs: 3000, error: 'timeout after 3000ms' }, llm: { status: 'up', latencyMs: 180 } }, uptimeS: 12 }],
    }),
  },
};

// ── Article pages ──

const articlePageExample = {
  document: { id: documentExample.id, title: AUDCG, language: 'fr', actCode: 'AUDCG', actVersion: '2010' },
  article: {
    articleRef: '7', sectionPath: 'Livre 1 > Titre 2 > Chapitre 1', pageStart: 3, pageEnd: 3,
    text: "Le mineur, sauf s'il est émancipé, ne peut avoir la qualité de commerçant ni effectuer des actes de commerce.",
    parts: [{ part: 0, content: "Le mineur, sauf s'il est émancipé, ne peut avoir la qualité de commerçant ni effectuer des actes de commerce.", pageStart: 3, pageEnd: 3 }],
  },
  decisions: [{
    id: '5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e', documentId: '6c2f3d4e-5a6b-4c7d-9e8f-0a1b2c3d4e5f',
    title: 'CCJA, 1re ch., arrêt n° 045/2019 du 28 février 2019', court: 'CCJA', country: null,
    caseNumber: 'Arrêt n° 045/2019', decisionDate: '2019-02-28', outcome: 'rejet',
    headnote: "Le mineur émancipé peut avoir la qualité de commerçant. …",
    citedAs: ["l'article 7 de l'Acte uniforme portant sur le droit commercial général"], confidence: 'high',
  }],
};

export const articlePageRouteSchema = {
  tags: ['articles'],
  summary: 'An article with the published decisions that cite it',
  description: 'The article text (every part) and the published decisions citing it, newest first, with court, date and '
    + 'headnote. Links come from the citation job (rules, then an LLM for the references the rules cannot resolve); '
    + 'low-confidence links wait for a reviewer and are not shown.',
  params: articleParamsSchema,
  response: {
    200: success(articlePageSchema).meta({ examples: [{ status: 'success', data: articlePageExample }] }),
    404: failed.meta({ examples: [{ status: 'failed', message: 'Article not found' }] }),
    422: validationFailed('articleRef', 'An article number, e.g. "7", "12 bis", "35-1", "1er"'),
  },
};

// ── Search ──

// Invented, like the review example: a decision as the public sees it once published (names already replaced)
const decisionHitExample = {
  id: '5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e', documentId: '6c2f3d4e-5a6b-4c7d-9e8f-0a1b2c3d4e5f',
  title: 'CCJA, 1re ch., arrêt n° 045/2019 du 28 février 2019', language: 'fr', court: 'CCJA', country: null,
  chamber: 'Première chambre', caseNumber: 'Arrêt n° 045/2019', decisionDate: '2019-02-28',
  subject: "Qualité de commerçant d'un mineur émancipé", outcome: 'rejet',
  headnote: 'Le mineur émancipé peut avoir la qualité de commerçant. …',
};
const snippetExample = "Sur le premier moyen, tiré de la violation de l'article 7 de l'Acte uniforme portant sur le droit commercial général …";

export const searchDecisionsRouteSchema = {
  tags: ['search'],
  summary: 'Search published decisions',
  description: 'Filters combine with AND. With `q`, decisions are ranked by their closest section to the question '
    + '(a decision whose case number is in `q` comes first); without it, newest first. `q` orders the matching decisions '
    + 'and never removes one: `total` counts every published decision matching the filters. A page past the end is 200 '
    + 'with no items. Drafts and decisions in review never appear. 60 requests per minute per IP.',
  querystring: decisionSearchQuerySchema,
  response: {
    200: success(decisionSearchPageSchema).meta({ examples: [{ status: 'success', data: {
      items: [{ ...decisionHitExample, match: { similarity: 0.71, section: 'moyen-1', snippet: snippetExample, caseNumber: false } }],
      page: 1, limit: 20, total: 1, totalPages: 1,
    } }] }),
    422: validationFailed('act', 'article and version need act'),
    429: failedExample('Rate limit exceeded, retry in 1 minute'),
  },
};

export const searchAllRouteSchema = {
  tags: ['search'],
  summary: 'Search articles and published decisions in one list',
  description: 'One list for one search box, each item with its `type`. Ordered by similarity to `q` (the same model '
    + 'scores both, so the scores compare); a decision whose case number is in `q` comes first. 60 requests per minute per IP.',
  querystring: searchAllQuerySchema,
  response: {
    200: success(z.array(searchItemSchema)).meta({ examples: [{ status: 'success', data: [
      { type: 'article', similarity: 0.78, documentId: documentExample.id, documentTitle: AUDCG, articleRef: '7', pageStart: 3,
        snippet: "Le mineur, sauf s'il est émancipé, ne peut avoir la qualité de commerçant ni effectuer des actes de commerce." },
      { type: 'decision', similarity: 0.71, ...decisionHitExample, section: 'moyen-1', snippet: snippetExample },
    ] }] }),
    422: validationFailed('q', 'Too small: expected string to have >=1 characters'),
    429: failedExample('Rate limit exceeded, retry in 1 minute'),
  },
};

export const decisionStatsRouteSchema = {
  tags: ['search'],
  summary: 'Published decisions by court, country and year',
  description: 'Counts for the search filters. The court values are the ones GET /api/decisions?court= expects.',
  response: {
    200: success(decisionStatsSchema).meta({ examples: [{ status: 'success', data: {
      total: 3,
      byCourt: [{ court: 'CCJA', count: 2 }, { court: 'Cour suprême du Cameroun', count: 1 }],
      byCountry: [{ country: null, count: 2 }, { country: 'CM', count: 1 }],
      byYear: [{ year: 2021, count: 1 }, { year: 2019, count: 2 }],
    } }] }),
  },
};
