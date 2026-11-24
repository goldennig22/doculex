
export type PageText = { page: number; text: string };

export type UploadDocumentInput = {
    file: Buffer,
    title: string,
    language: 'fr'|'en',
    sourceUrl?: string|null,
}

export type ChunkDraft = {
  articleRef: string; // "1", "12 bis", "35-1"
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

export type Citation = { document: string; article: string; pages: number[]; quote: string };
export type AskResponse = {
  found: boolean;
  answer: string | null;
  citations: Citation[];
  confidence: 'high' | 'medium' | 'low' | null;
  language: Lang;
};

export type Lang = 'fr' | 'en';

export type SourceRef = { document: string; article: string };

export type AskTrace = UserQuery & { sourceArticles: SourceRef[] }; 

export type AskResult = { response: AskResponse; trace: AskTrace };