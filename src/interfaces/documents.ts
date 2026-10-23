export type PageText = { page: number; text: string };
export type Chunk = {
    id: string; 
    documentId: string; 
    articleRef: string;
    pageStart: number;
    pageEnd: number;
    content: string;
    lang: string,
    tokenCount: number|null,
};

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
  tokenCount: number;
};

export type ShowDocumentInput = {
    documentId: string
}