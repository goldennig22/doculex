// Pure grading for eval-answers.ts: no LLM judge, only facts the pipeline already verified.
// A citation reaching this point passed quote verification, so "cites an expected article" means
// "answered, grounded in verbatim text of the right article". Whether the sentence itself is right is
// NOT checked here: read the printed answers next to expected_answer_summary for that.
import { detectLanguage } from '../../services/search.service';
import type { AskResult, Lang, UserQuery } from '../../interfaces/types';

export type EvalQuestion = {
  id: number;
  language: Lang;
  category: 'in_document' | 'out_of_document';
  question: string;
  expected_answer_summary?: string;
  expected_articles?: string[];
  expected_title?: string;
};

export type Verdict =
  | 'correct'        // in-document: answered, cites an expected article of the expected document
  | 'wrong_article'  // in-document: answered, but every citation is to another article (read it: may be a labelling error)
  | 'missed'         // in-document: refused (see stoppedAt and retrieved)
  | 'refused'        // out-of-document: refused, as it should
  | 'answered'       // out-of-document: answered a question the corpus can't answer
  | 'error';         // every model failed

export type Grade = {
  id: number;
  category: EvalQuestion['category'];
  verdict: Verdict;
  stoppedAt: UserQuery['stoppedAt'];
  /** in-document only: was an expected article among the sources sent to the LLM? false = retrieval miss */
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

export function gradeAnswer(q: EvalQuestion, result: AskResult): Grade {
  const { response, trace } = result;
  const citedArticles = response.citations.map((c) => c.article);
  const inDoc = q.category === 'in_document';

  let verdict: Verdict;
  if (!inDoc) verdict = response.found ? 'answered' : 'refused';
  else if (!response.found) verdict = 'missed';
  else verdict = response.citations.some((c) => isExpected(q, c.document, c.article)) ? 'correct' : 'wrong_article';

  return {
    id: q.id,
    category: q.category,
    verdict,
    stoppedAt: trace.stoppedAt,
    retrieved: inDoc ? trace.sourceArticles.some((s) => isExpected(q, s.document, s.article)) : null,
    languageOk: response.found && response.answer ? detectLanguage(response.answer) === q.language : null,
    citedArticles,
    model: trace.model,
    latencyMs: trace.latencyMs,
    costUsd: trace.costUsd,
  };
}

/** A question whose every model failed: no trace comes back, only the error. */
export const errorGrade = (q: EvalQuestion): Grade => ({
  id: q.id, category: q.category, verdict: 'error', stoppedAt: 'error', retrieved: null, languageOk: null,
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
