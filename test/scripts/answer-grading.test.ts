import { describe, it, expect } from 'vitest';
import { errorGrade, gradeAnswer, percentile, summarize, type EvalQuestion } from '../../src/scripts/lib/answer-grading';
import type { AskResult, AskResponse, AskTrace, Citation } from '../../src/interfaces/types';

const AUDCG = 'Acte uniforme OHADA du 15 décembre 2010 portant sur le droit commercial généra';
const AUSCGIE = 'UNIFORM ACT RELATING TO COMMERCIAL COMPANIES';

// Questions 1, 2 and 14 of eval/questions.json
const q1: EvalQuestion = {
  id: 1, language: 'fr', category: 'in_document', expected_articles: ['2', '6', '7', '8'], expected_title: AUDCG,
  question: "Quelles sont les conditions requises pour qu'une personne physique ait la qualité de commerçant ?",
};
const q2: EvalQuestion = {
  id: 2, language: 'en', category: 'in_document', expected_articles: ['60'], expected_title: AUDCG,
  question: 'What are the legal consequences if a person fails to register in the RCCM within the prescribed time limits?',
};
const q14: EvalQuestion = {
  id: 14, language: 'en', category: 'out_of_document',
  question: 'What are the specific labor law requirements for dismissing an employee in Cameroon?',
};

const cite = (article: string, document = AUDCG): Citation => ({ document, article, pages: [3, 3], quote: 'x'.repeat(25) });

function result(
  response: Partial<AskResponse>,
  trace: Partial<AskTrace> = {},
): AskResult {
  return {
    response: { found: true, answer: null, citations: [], confidence: 'high', language: 'fr', ...response },
    trace: {
      question: '', language: 'fr', found: true, stoppedAt: null, topSimilarity: 0.78, model: 'claude-haiku-5-5',
      inputTokens: 3000, outputTokens: 200, costUsd: 0.0004, latencyMs: 2500, sourceArticles: [], ...trace,
    },
  };
}
const refusal = (stoppedAt: AskTrace['stoppedAt'], trace: Partial<AskTrace> = {}) =>
  result({ found: false, answer: null, citations: [], confidence: null }, { found: false, stoppedAt, ...trace });

describe('gradeAnswer: in-document', () => {
  it('is correct when one citation is an expected article of the expected document', () => {
    const g = gradeAnswer(q1, result({
      answer: "Est commerçant celui qui fait de l'accomplissement d'actes de commerce sa profession.",
      citations: [cite('3'), cite('2')],
    }));
    expect(g.verdict).toBe('correct');
    expect(g.citedArticles).toEqual(['3', '2']);
    expect(g.languageOk).toBe(true);
  });

  it('is a wrong article when the right number comes from the other Act', () => {
    // Art. 2 exists in both Acts: the document must match too
    expect(gradeAnswer(q1, result({ answer: 'Le commerçant est…', citations: [cite('2', AUSCGIE)] })).verdict)
      .toBe('wrong_article');
  });

  it('is missed when refused, and says whether retrieval found the expected article', () => {
    const atLlm = gradeAnswer(q1, refusal('llm', { sourceArticles: [{ document: AUDCG, article: '7' }] }));
    expect(atLlm).toMatchObject({ verdict: 'missed', stoppedAt: 'llm', retrieved: true, languageOk: null });

    const atThreshold = gradeAnswer(q1, refusal('threshold'));
    expect(atThreshold).toMatchObject({ verdict: 'missed', stoppedAt: 'threshold', retrieved: false });
  });

  it('flags an answer in the wrong language (English question, French answer)', () => {
    const g = gradeAnswer(q2, result({
      answer: "La personne ne peut pas se prévaloir de la qualité de commerçant tant qu'elle n'est pas immatriculée.",
      citations: [cite('60')],
    }));
    expect(g.verdict).toBe('correct');
    expect(g.languageOk).toBe(false);
  });
});

describe('gradeAnswer: out-of-document', () => {
  it('is refused when found is false, keeping which layer stopped it', () => {
    expect(gradeAnswer(q14, refusal('threshold'))).toMatchObject({ verdict: 'refused', stoppedAt: 'threshold', retrieved: null });
  });

  it('is answered (a failure) when found is true', () => {
    expect(gradeAnswer(q14, result({ answer: 'The employer must give notice.', citations: [cite('9')] })).verdict)
      .toBe('answered');
  });
});

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const v = [900, 100, 300, 200, 500, 400, 600, 700, 800, 1000];
    expect(percentile(v, 50)).toBe(500);
    expect(percentile(v, 95)).toBe(1000);
  });
  it('is null for no values', () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe('summarize', () => {
  it('counts verdicts, refusal layers, latency and cost', () => {
    const grades = [
      gradeAnswer(q1, result({ answer: 'Est commerçant celui qui…', citations: [cite('2')] }, { latencyMs: 3000, costUsd: 0.0004 })),
      gradeAnswer(q1, refusal('llm', { latencyMs: 2000, costUsd: 0.0002, sourceArticles: [{ document: AUDCG, article: '6' }] })),
      gradeAnswer(q14, refusal('threshold', { latencyMs: 300, model: null, costUsd: null })),
      gradeAnswer(q14, refusal('llm', { latencyMs: 1800, model: 'gpt-6-luna', costUsd: null })),
      errorGrade(q2),
    ];

    const s = summarize(grades);

    expect(s.inDocument).toMatchObject({
      total: 3, correct: 1, wrongArticle: 0, missedBy: { llm: 1 }, errors: 1, missesWithArticleRetrieved: 1, misses: 1,
    });
    expect(s.outOfDocument).toMatchObject({ total: 2, refused: 2, refusedBy: { threshold: 1, llm: 1 }, answered: 0 });
    expect(s.latencyMs.mean).toBe(Math.round((3000 + 2000 + 300 + 1800) / 4)); // the error has no latency
    expect(s.cost.totalUsd).toBeCloseTo(0.0006, 10);
    expect(s.cost.meanPerLlmCallUsd).toBeCloseTo(0.0003, 10);
    expect(s.cost).toMatchObject({ llmCalls: 3, unpricedCalls: 1 }); // the threshold refusal made no LLM call
    expect(s.models).toEqual({ 'claude-haiku-5-5': 2, 'gpt-6-luna': 1 });
  });
});
