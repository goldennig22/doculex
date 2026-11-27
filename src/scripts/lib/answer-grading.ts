// Pure grading for eval-answers.ts: no LLM judge, only facts the pipeline already verified.
// A citation reaching this point passed quote verification, so "cites an expected article" means
// "answered, grounded in verbatim text of the right article". Whether the sentence itself is right is
// NOT checked here: read the printed answers next to expected_answer_summary for that.
import { detectLanguage } from '../../services/search.service';
import { caseNumberPattern } from '../../services/decision-search.service';
import type { AskResult, Lang, UserQuery } from '../../interfaces/types';

export type Category = 'in_document' | 'out_of_document' | 'case_law';

export type EvalQuestion = {
  id: number;
  language: Lang;
  category: Category;
  question: string;
  expected_answer_summary?: string;
  /** case_law: the case law that answers it, e.g. "191/2015" (any zero-padding, see matchesCaseNumber) */
  expected_case_numbers?: string[];
  /** in_document: required. case_law: the article of an INGESTED Act the decision applies, when there is one */
  expected_articles?: string[];
  expected_title?: string;
};

export type Verdict =
  | 'correct'        // in-document: answered, cites an expected article of the expected document
  | 'wrong_article'  // in-document or case-law: answered, but every citation is to another article (read it: may be a labelling error)
  | 'missed'         // in-document or case-law: refused (see stoppedAt and retrieved)
  | 'article_only'   // case-law: answered from an expected article, without the decision. The best a statutes-only /ask
                     // can do; a case-law 'correct' (cites the expected decision) needs typed citations (Weekend 13, step 2)
  | 'refused'        // out-of-document: refused, as it should
  | 'answered'       // out-of-document: answered a question the corpus can't answer
  | 'error';         // every model failed

/**
 * Does a stored case number ("Arrêt N° 045/2019", "Ordonnance N°008/2015/CCJA") match one of the expected ones
 * ("45/2019")? Same rule as the case-number search (caseNumberPattern), so the eval and GET /api/decisions agree.
 */
export function matchesCaseNumber(expected: string[], actual: string | null): boolean {
  if (actual === null) return false;
  return expected.some((e) => {
    const pattern = caseNumberPattern(e);
    if (pattern === null) throw new Error(`Not a case number: "${e}" (expected_case_numbers in eval/questions.json)`);
    return new RegExp(pattern).test(actual);
  });
}

export type Grade = {
  id: number;
  category: Category;
  language: Lang;
  verdict: Verdict;
  stoppedAt: UserQuery['stoppedAt'];
  /** in-document and case-law with an article: was an expected article among the sources sent to the LLM? */
  retrieved: boolean | null;
  /** answered questions only: is the answer in the language of the question? */
  languageOk: boolean | null;
  citedArticles: string[];
  model: string | null;
  latencyMs: number | null;
  costUsd: number | null;
};

const isExpected = (q: EvalQuestion, document: string, article: string) =>
  (q.expected_articles ?? []).includes(article) && (!q.expected_title || q.expected_title === document);

function verdictOf(q: EvalQuestion, response: AskResult['response']): Verdict {
  const citesExpected = response.citations.some((c) => isExpected(q, c.document, c.article));
  switch (q.category) {
    case 'out_of_document':
      return response.found ? 'answered' : 'refused';
    case 'in_document':
      if (!response.found) return 'missed';
      return citesExpected ? 'correct' : 'wrong_article';
    case 'case_law':
      if (!response.found) return 'missed';
      return citesExpected ? 'article_only' : 'wrong_article';
    default: {
      const never: never = q.category;
      throw new Error(`Unknown category: ${String(never)}`);
    }
  }
}

export function gradeAnswer(q: EvalQuestion, result: AskResult): Grade {
  const { response, trace } = result;
  const citedArticles = response.citations.map((c) => c.article);
  const hasArticle = (q.expected_articles ?? []).length > 0;

  return {
    id: q.id,
    category: q.category,
    language: q.language,
    verdict: verdictOf(q, response),
    stoppedAt: trace.stoppedAt,
    retrieved: hasArticle ? trace.sourceArticles.some((s) => isExpected(q, s.document, s.article)) : null,
    languageOk: response.found && response.answer ? detectLanguage(response.answer) === q.language : null,
    citedArticles,
    model: trace.model,
    latencyMs: trace.latencyMs,
    costUsd: trace.costUsd,
  };
}

/** A question whose every model failed: no trace comes back, only the error. */
export const errorGrade = (q: EvalQuestion): Grade => ({
  id: q.id, category: q.category, language: q.language, verdict: 'error', stoppedAt: 'error', retrieved: null, languageOk: null,
  citedArticles: [], model: null, latencyMs: null, costUsd: null,
});

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const countBy = <T>(items: T[], key: (t: T) => string | null) =>
  items.reduce<Record<string, number>>((acc, t) => {
    const k = key(t) ?? 'none';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

export function summarize(grades: Grade[]) {
  const inDoc = grades.filter((g) => g.category === 'in_document');
  const outDoc = grades.filter((g) => g.category === 'out_of_document');
  const caseLaw = grades.filter((g) => g.category === 'case_law');
  // What counts as a success for each category, so one table can show category × language
  const success: Record<Category, Verdict[]> = {
    in_document: ['correct'], out_of_document: ['refused'], case_law: ['correct', 'article_only'],
  };
  const byCategoryLanguage: Record<string, { ok: number; total: number }> = {};
  for (const g of grades) {
    const cell = (byCategoryLanguage[`${g.category}/${g.language}`] ??= { ok: 0, total: 0 });
    cell.total++;
    if (success[g.category].includes(g.verdict)) cell.ok++;
  }
  const missed = inDoc.filter((g) => g.verdict === 'missed' || g.verdict === 'wrong_article');
  const answered = grades.filter((g) => g.languageOk !== null);
  const timed = grades.flatMap((g) => (g.latencyMs === null ? [] : [g.latencyMs]));
  const priced = grades.flatMap((g) => (g.costUsd === null ? [] : [g.costUsd]));
  const llmCalls = grades.filter((g) => g.model !== null);

  return {
    inDocument: {
      total: inDoc.length,
      correct: inDoc.filter((g) => g.verdict === 'correct').length,
      wrongArticle: inDoc.filter((g) => g.verdict === 'wrong_article').length,
      missedBy: countBy(inDoc.filter((g) => g.verdict === 'missed'), (g) => g.stoppedAt),
      errors: inDoc.filter((g) => g.verdict === 'error').length,
      // of the misses, how many had the right article in the sources: those are generation misses, not retrieval misses
      missesWithArticleRetrieved: missed.filter((g) => g.retrieved).length,
      misses: missed.length,
    },
    outOfDocument: {
      total: outDoc.length,
      refused: outDoc.filter((g) => g.verdict === 'refused').length,
      refusedBy: countBy(outDoc.filter((g) => g.verdict === 'refused'), (g) => g.stoppedAt),
      answered: outDoc.filter((g) => g.verdict === 'answered').length,
      errors: outDoc.filter((g) => g.verdict === 'error').length,
    },
    caseLaw: {
      total: caseLaw.length,
      correct: caseLaw.filter((g) => g.verdict === 'correct').length,
      articleOnly: caseLaw.filter((g) => g.verdict === 'article_only').length,
      wrongArticle: caseLaw.filter((g) => g.verdict === 'wrong_article').length,
      missedBy: countBy(caseLaw.filter((g) => g.verdict === 'missed'), (g) => g.stoppedAt),
      errors: caseLaw.filter((g) => g.verdict === 'error').length,
    },
    byCategoryLanguage,
    language: { ok: answered.filter((g) => g.languageOk).length, answered: answered.length },
    latencyMs: {
      mean: timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null,
      p50: percentile(timed, 50),
      p95: percentile(timed, 95),
    },
    cost: {
      totalUsd: priced.reduce((a, b) => a + b, 0),
      // per LLM call with a known price; threshold refusals cost nothing and would pull the mean down
      meanPerLlmCallUsd: priced.length ? priced.reduce((a, b) => a + b, 0) / priced.length : null,
      llmCalls: llmCalls.length,
      unpricedCalls: llmCalls.length - priced.length,
    },
    models: countBy(llmCalls, (g) => g.model),
  };
}
