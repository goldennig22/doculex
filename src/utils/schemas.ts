import z from "zod";

const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
export const uploadDocumentSchema = z.object({
    file: z.instanceof(Buffer, { message: 'file is required' }).refine(isPdf, 'file must be a PDF'),
    title: z.string().trim().min(3).max(200),
    language: z.enum(['fr', 'en']),
    sourceUrl: z.url().optional(),
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
    chunkCount: z.number().int(),
    createdAt: z.date(),
})
