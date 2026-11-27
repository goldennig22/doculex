import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { decisionCitations, decisions, documents } from '../db/schema';
import { getArticleParts, searchableDocuments } from './search.service';

// The "annotated code" page: one article of a statute, every part of it, and the published decisions that cite it.

/** At most this many decisions on one page, newest first. */
export const MAX_CITING_DECISIONS = 50;

export type ArticlePage = {
  document: { id: string; title: string; language: string; actCode: string | null; actVersion: string | null };
  article: {
    articleRef: string;
    sectionPath: string | null;
    pageStart: number;
    pageEnd: number;
    /** Every part joined, in order */
    text: string;
    parts: { part: number; content: string; pageStart: number; pageEnd: number }[];
  };
  decisions: {
    id: string;
    documentId: string;
    title: string;
    court: string | null;
    country: string | null;
    caseNumber: string | null;
    decisionDate: string | null;
    outcome: string | null;
    headnote: string | null;
    /** How the decision cites the article: "l'article 7 de l'AUDCG", "articles 13 à 15 du même Acte uniforme" */
    citedAs: string[];
    /** The best of its links to this article. 'low' links are for reviewers and never shown. */
    confidence: 'high' | 'medium';
  }[];
};

/** null when the statute or the article doesn't exist (a decision's id included: statutes only). */
export async function getArticlePage(documentId: string, articleRef: string): Promise<ArticlePage | null> {
  // getArticleParts applies searchableDocuments (statutes only by default): a decision's document id finds nothing
  const parts = await getArticleParts([{ documentId, articleRef }]);
  if (parts.length === 0) return null;

  const [doc] = await db
    .select({ id: documents.id, title: documents.title, language: documents.language, actCode: documents.actCode, actVersion: documents.actVersion })
    .from(documents).where(eq(documents.id, documentId));

  const citing = doc.actCode === null || doc.actVersion === null ? [] : await db
    .select({
      id: decisions.id,
      documentId: decisions.documentId,
      title: documents.title,
      court: decisions.court,
      country: decisions.country,
      caseNumber: decisions.caseNumber,
      decisionDate: decisions.decisionDate,
      outcome: decisions.outcome,
      headnote: decisions.headnote,
      citedAs: sql<string[]>`array_agg(DISTINCT ${decisionCitations.rawText} ORDER BY ${decisionCitations.rawText})`,
      high: sql<boolean>`bool_or(${decisionCitations.confidence} = 'high')`,
    })
    .from(decisionCitations)
    .innerJoin(decisions, eq(decisions.id, decisionCitations.decisionId))
    .innerJoin(documents, eq(documents.id, decisions.documentId))
    .where(and(
      eq(decisionCitations.actCode, doc.actCode),
      eq(decisionCitations.actVersion, doc.actVersion),
      eq(decisionCitations.articleRef, articleRef),
      ne(decisionCitations.confidence, 'low'),
      // The one definition of "visible": a draft, in-review or rejected decision never appears here
      searchableDocuments(['decision']),
    ))
    .groupBy(decisions.id, documents.id)
    .orderBy(sql`${decisions.decisionDate} DESC NULLS LAST`, desc(decisions.publishedAt), asc(decisions.id))
    .limit(MAX_CITING_DECISIONS);

  const first = parts[0];
  return {
    document: doc,
    article: {
      articleRef: first.articleRef,
      sectionPath: first.sectionPath,
      pageStart: Math.min(...parts.map((p) => p.pageStart)),
      pageEnd: Math.max(...parts.map((p) => p.pageEnd)),
      text: parts.map((p) => p.content).join('\n\n'),
      parts: parts.map((p) => ({ part: p.part, content: p.content, pageStart: p.pageStart, pageEnd: p.pageEnd })),
    },
    decisions: citing.map(({ high, ...d }) => ({ ...d, confidence: high ? 'high' : 'medium' })),
  };
}
