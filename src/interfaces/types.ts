import type { z } from 'zod';
import type { askResponseSchema, citationSchema, langSchema } from '../utils/schemas';
import type { ActCode } from '../services/citations/acts';

export type PageText = { page: number; text: string };

export type UploadDocumentInput = {
    file: Buffer,
    title: string,
    language: 'fr'|'en',
    sourceUrl?: string|null,
    actCode?: ActCode,
    actVersion?: string,
}

export type ChunkDraft = {
  articleRef: string; // statute: "1", "12 bis", "35-1"; decision: a section ("faits", "moyen-2", "dispositif")
  part: number; // 0 for the first (or only) part of an article
  pageStart: number;
  pageEnd: number;
  content: string;
  sectionPath: string|null;
  tokenCount: number;
};

export type ShowDocumentInput = {
    documentId: string
}

export type SearchResult = {
    id: string,
    articleRef: string,
    pageStart: number,
    content: string,
    similarity?: number,
    documentTitle: string,
    documentId: string,
}

export type Source = {
    n: number,
    articleRef: string,
    documentTitle: string,
    content: string,
    documentId: string,
    pageStart: number,
    pageEnd: number,
    sectionPath: string|null,
    
}

export type UserQuery = {
    id?: string,
    question: string,
    language: string,
    found: boolean,
    stoppedAt: 'threshold' | 'llm' | 'no_valid_citation' | 'error'| null,
    topSimilarity: number|null,
    model: string|null,
    inputTokens: number|null,
    outputTokens: number|null,
    costUsd: number|null,
    latencyMs: number,
}

// Inferred from the response schemas, so the API docs, the serializer and the code can't disagree
export type Citation = z.infer<typeof citationSchema>;

export type AskResponse = z.infer<typeof askResponseSchema>;

export type Lang = z.infer<typeof langSchema>;

export type SourceRef = { document: string; article: string };

export type AskTrace = UserQuery & { sourceArticles: SourceRef[] }; 

export type AskResult = { response: AskResponse; trace: AskTrace };

export type Role = 'admin' | 'reviewer' | 'contributor';

export type ApiKeyIdentity = { id: string | null; role: Role; label: string }; 
export type DocumentKind = 'statute' | 'decision';
