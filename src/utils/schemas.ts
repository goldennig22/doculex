import z from "zod";
import { anonymisationStatus, decisionOutcome } from "../db/schema";
import { ACTS, LINKABLE_ACT_CODES } from "../services/citations/acts";

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
export const uploadDocumentSchema = z.object({
    file: z.instanceof(Buffer, { message: 'file is required' }).refine(isPdf, 'file must be a PDF'),
    title: z.string().trim().min(3).max(200),
    language: z.enum(['fr', 'en']),
    sourceUrl: z.url().optional(),
    actCode: z.enum(LINKABLE_ACT_CODES).optional()
        .describe('Which act this statute is, so decisions citing it link to it: AUDCG, AUSCGIE, AUPSRVE…'),
    actVersion: z.string().trim().optional().describe('The version of that act, by adoption year: "2010" for the revised AUDCG'),
}).refine((b) => (b.actCode === undefined) === (b.actVersion === undefined), {
    message: 'Send both actCode and actVersion, or neither', path: ['actVersion'],
}).refine((b) => !b.actCode || ACTS[b.actCode].versions.some((v) => v.version === b.actVersion), {
    message: 'Unknown version for this act (see src/services/citations/acts.ts)', path: ['actVersion'],
})

export const documentIdSchema = z.object({
    documentId: z.uuid(),
})

export const searchQuestionSchema = z.object({
    question: z.string().trim().min(3).max(1000)
})

// ── Responses: the serializer checks every response against these, and the OpenAPI docs are generated from them ──

export const langSchema = z.enum(['fr', 'en']);

export const citationSchema = z.object({
    document: z.string(),
    article: z.string().describe('Article number as printed in the Act, e.g. "2", "12 bis", "35-1"'),
    pages: z.array(z.number().int()).describe('[first page, last page] of the article in the PDF'),
    quote: z.string().describe('Verified: found word for word in the article'),
})

export const askResponseSchema = z.object({
    found: z.boolean().describe('false when the Acts do not contain the answer; answer is then null and citations empty'),
    answer: z.string().nullable(),
    citations: z.array(citationSchema),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
    language: langSchema.describe('Language of the question, and of the answer'),
})

export const documentSchema = z.object({
    id: z.uuid(),
    kind: z.enum(['statute', 'decision']),
    title: z.string(),
    language: z.string(),
    sourceUrl: z.string().nullable(),
    pageCount: z.number().int(),
    actCode: z.string().nullable().describe('For a statute: the act it holds ("AUDCG"); null otherwise'),
    actVersion: z.string().nullable().describe('For a statute: the version it holds ("2010"); null otherwise'),
    createdAt: z.date(),
})


// ── Decisions ──

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

// Multipart: every field arrives as a string, the file as a Buffer (attachFieldsToBody: 'keyValues').
// The decision is a PDF OR pasted text, never both: with both, which one is the decision?
export const createDecisionSchema = z.object({
    file: z.instanceof(Buffer).refine(isPdf, 'file must be a PDF').optional()
        .describe('The judgment as a PDF. Send exactly one of file or text'),
    text: z.string().trim().min(200).max(500_000).optional()
        .describe('The judgment as plain text, when there is no usable PDF. Send exactly one of file or text'),
    title: z.string().trim().min(3).max(300)
        .describe('How the decision is cited, e.g. "CCJA, 1re ch., arrêt n° 045/2019 du 28 février 2019"'),
    language: z.enum(['fr', 'en']),
    sourceName: z.string().trim().min(2).max(200).describe('Where the decision comes from, e.g. "Ohadata"'),
    sourceUrl: z.url().optional(),
    court: optionalText(200),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2 code, e.g. CM')
        .transform((c) => c.toUpperCase()).optional(),
    chamber: optionalText(200),
    caseNumber: optionalText(100),
    decisionDate: z.iso.date().optional().describe('YYYY-MM-DD'),
}).refine((b) => (b.file === undefined) !== (b.text === undefined), {
    message: 'Send exactly one of file or text',
    path: ['file'], // a root-level issue would be missing from the 422's `errors` (flattenError keeps fields only)
});

export const decisionStatusSchema = z.enum(['draft', 'in_review', 'published', 'rejected']);
export const extractionStatusSchema = z.enum(['pending', 'done', 'needs_manual_entry'])
    .describe('AI metadata extraction: pending (queued), done, or needs_manual_entry (a person types the fields)');

export const decisionSchema = z.object({
    id: z.uuid(),
    documentId: z.uuid(),
    title: z.string(),
    language: langSchema,
    status: decisionStatusSchema,
    court: z.string().nullable(),
    country: z.string().nullable(),
    chamber: z.string().nullable(),
    caseNumber: z.string().nullable(),
    decisionDate: z.string().nullable(),
    sourceName: z.string(),
    sourceUrl: z.string().nullable(),
    extractionStatus: extractionStatusSchema,
    anonymisationStatus: z.enum(anonymisationStatus.enumValues)
        .describe('Detection of natural persons\' names: pending, done, or needs_manual_review (only the rules ran)'),
    chunkCount: z.number().int(),
    createdAt: z.date(),
})

// ── Review: names and metadata, then publish ──

export const decisionIdSchema = z.object({
    decisionId: z.uuid(),
})

const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
const PLACEHOLDER = /^[A-Z](?:[2-9]|[1-9]\d+)?$/; // same as PLACEHOLDER_FORMAT in anonymisation/mentions.ts

export const mentionActionSchema = z.discriminatedUnion('action', [
    z.object({ id: z.uuid(), action: z.literal('confirm') })
        .describe('It is a natural person: keep the placeholder. The clear name is erased.'),
    z.object({ id: z.uuid(), action: z.literal('not_a_person') })
        .describe('Not a person (a company, a judge): the original text is put back and the mention deleted. Only before confirming.'),
    z.object({ id: z.uuid(), action: z.literal('reassign'), placeholder: z.string().regex(PLACEHOLDER) })
        .describe('Another person\'s letter (two people were merged, or one was split)'),
]);

export const reviewPatchSchema = z.object({
    metadata: z.object({
        title: z.string().trim().min(3).max(300),
        court: nullableText(200),
        country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2 code, e.g. CM').transform((c) => c.toUpperCase()).nullable(),
        chamber: nullableText(200),
        caseNumber: nullableText(100),
        decisionDate: z.iso.date().nullable(),
        subject: nullableText(300),
        outcome: z.enum(decisionOutcome.enumValues).nullable(),
        headnote: nullableText(3000),
    }).partial().strict().optional(),
    mentions: z.array(mentionActionSchema).max(500).optional(),
    addMentions: z.array(z.object({
        surface: z.string().trim().min(2).max(200).describe('A name detection missed, as written; every occurrence is replaced and confirmed'),
        placeholder: z.string().regex(PLACEHOLDER).optional().describe('An existing person\'s letter; a new one when left out'),
    })).max(50).optional(),
    anonymisationChecked: z.literal(true).optional()
        .describe('After a failed detection (needs_manual_review): I read the whole text and every name is handled'),
    status: decisionStatusSchema.optional()
        .describe('in_review (only after a failed detection) or rejected; publishing has its own route'),
}).strict().refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: 'Nothing to change',
    path: ['status'], // a root-level issue would be missing from the 422's `errors`
});

export const mentionViewSchema = z.object({
    id: z.uuid(),
    placeholder: z.string(),
    segment: z.string().describe('"caption", or the section: "faits", "moyen-1", "dispositif (part 2)"'),
    start: z.number().int(),
    end: z.number().int(),
    context: z.string().describe('The anonymised text around the placeholder'),
    original: z.string().nullable().describe('The clear name, until the mention is confirmed; null after'),
    source: z.enum(['rule', 'llm', 'both', 'reviewer']).describe('Who found it; check "rule" and "llm" first, they disagreed'),
    confirmed: z.boolean(),
});

export const reviewViewSchema = z.object({
    id: z.uuid(),
    documentId: z.uuid(),
    title: z.string(),
    language: langSchema,
    status: decisionStatusSchema,
    anonymisationStatus: z.enum(anonymisationStatus.enumValues),
    extractionStatus: extractionStatusSchema,
    court: z.string().nullable(),
    country: z.string().nullable(),
    chamber: z.string().nullable(),
    caseNumber: z.string().nullable(),
    decisionDate: z.string().nullable(),
    subject: z.string().nullable(),
    outcome: z.enum(decisionOutcome.enumValues).nullable(),
    headnote: z.string().nullable(),
    caption: z.string().nullable().describe('Anonymised; erased when the decision is published or rejected'),
    sections: z.array(z.object({ ref: z.string(), part: z.number().int(), text: z.string() }))
        .describe('The whole text, anonymised, in reading order'),
    unconfirmedMentions: z.number().int(),
    pendingEmbeddings: z.number().int().describe('Chunks whose text changed and are not embedded again yet; publish waits for 0'),
    mentions: z.array(mentionViewSchema),
    publishedAt: z.date().nullable(),
})

// ── Article pages ──

// Same format as chunks.article_ref once normalised: "1er" → "1", "12BIS" → "12 bis"
const ARTICLE_REF = /^(1er|premier|\d+(?:-\d+)?)(?:\s*(bis|ter|quater|quinquies|sexies|septies|octies))?$/i;

export const articleParamsSchema = z.object({
    documentId: z.uuid(),
    articleRef: z.string().trim().max(30)
        .regex(ARTICLE_REF, 'An article number, e.g. "7", "12 bis", "35-1", "1er"')
        .transform((ref) => {
            const m = ARTICLE_REF.exec(ref)!;
            const n = /^(1er|premier)$/i.test(m[1]) ? '1' : m[1];
            return m[2] ? `${n} ${m[2].toLowerCase()}` : n;
        })
        .describe('The article number as printed in the Act ("12 bis" is sent as 12%20bis)'),
});

export const articlePageSchema = z.object({
    document: z.object({
        id: z.uuid(), title: z.string(), language: z.string(),
        actCode: z.string().nullable(), actVersion: z.string().nullable(),
    }),
    article: z.object({
        articleRef: z.string(),
        sectionPath: z.string().nullable(),
        pageStart: z.number().int(),
        pageEnd: z.number().int(),
        text: z.string().describe('Every part of the article, joined in order'),
        parts: z.array(z.object({ part: z.number().int(), content: z.string(), pageStart: z.number().int(), pageEnd: z.number().int() })),
    }),
    decisions: z.array(z.object({
        id: z.uuid(),
        documentId: z.uuid(),
        title: z.string(),
        court: z.string().nullable(),
        country: z.string().nullable(),
        caseNumber: z.string().nullable(),
        decisionDate: z.string().nullable(),
        outcome: z.string().nullable(),
        headnote: z.string().nullable(),
        citedAs: z.array(z.string()).describe('How the decision cites the article, as written in it'),
        confidence: z.enum(['high', 'medium']).describe('high: the act is named next to the article; medium: inferred, or found by the LLM'),
    })).describe('Published decisions citing this article, newest first (at most 50)'),
});
