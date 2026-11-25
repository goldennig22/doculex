# DocuLex

**Bilingual legal Q&A API for OHADA business law: ask in French or English, get the exact article it comes from.**

<!-- Replace once available: [Live demo](https://…) · ![pipeline](https://gitlab.com/<user>/doculex/badges/main/pipeline.svg) -->

DocuLex ingests OHADA Uniform Acts (PDF), splits them **article by article**, and makes them searchable in French and English. Version 1 is a retrieval API with cited answers. Version 2 adds a database of Cameroonian and OHADA court decisions linked to the articles they apply, because law students in Cameroon have no free place to find case law.

Built with Node.js 22, TypeScript, Fastify, Postgres + pgvector, Drizzle ORM and Vitest, with GitLab CI.

---

## Status

| Weekend | Goal | Status |
| --- | --- | --- |
| 1 | Skeleton: Fastify, Docker Postgres, migrations, CI | Done |
| 2 | Ingest: PDF upload, page extraction, article chunker | Done |
| 3 | Embeddings and vector search, first evaluation | Done |
| 4 | Hybrid search (full-text + vectors, RRF), measured against vector-only | Done: **vector-only kept** (see Results) |
| 5 | `/ask`: cited answers with Claude, verified quotes, two-layer `found: false`, model fallback, rate limit, query log, answer-level eval | Done |
| 6 | Production deploy to VPS from GitLab CI | Planned |
| 7 | Final evaluation, demo page, write-up | Planned |

---

## How it works

```mermaid
flowchart LR
  subgraph Ingest["Ingest (admin API key)"]
    A[Upload PDF] --> B[Extract text<br/>page by page]
    B --> C[Clean pages<br/>headers, hyphens, NUL]
    C --> D[Chunk by article<br/>+ section path]
    D --> E[Embed<br/>section path + text]
  end

  E --> DB[(Postgres + pgvector<br/>documents · chunks<br/>lexeme_stats · queries)]

  subgraph Ask["Ask (public, 10 / min / IP)"]
    Q[Question FR / EN] --> S[Vector search<br/>HNSW, cosine]
    S --> T{Top similarity<br/>≥ MIN_SIMILARITY?}
    T -- no --> N[found: false]
    T -- yes --> P[Top 5 articles,<br/>all parts joined]
    P --> L[LLM + Zod schema<br/>Claude → OpenAI → Gemini]
    L --> F{found?}
    F -- no --> N
    F -- yes --> V{A quote found<br/>verbatim in its source?}
    V -- no --> N
    V -- yes --> R[Answer + citations<br/>document · article · pages]
  end

  DB --> S
  DB -. measured, not used in v1 .-> K[Keyword search + RRF]
```

Every question writes one row to `queries`: where it stopped (`threshold`, `llm`, `no_valid_citation`, `error`, or answered), the model that answered, tokens, cost and latency.

### The ask pipeline

- **Layer 1, similarity threshold.** If the best article is further than `MIN_SIMILARITY` from the question, the API refuses without calling the LLM. It costs only the embedding.
- **Sources are whole articles.** The top 5 articles (one chunk each after de-duplication) are rebuilt from all their parts, so a long article isn't cut in the middle of a condition.
- **Structured output.** The LLM must return `{ found, answer, citations: [{ source, quote }], confidence }`, validated with Zod. It answers in the language of the question, even from a source in the other language.
- **Layer 2a, the model refuses** with `found: false` when the sources don't contain the answer.
- **Layer 2b, quote verification.** Each citation must name a source that was sent and quote at least 20 characters found verbatim in it (case, whitespace and apostrophes normalised). Citations that fail are dropped; if none is left, the answer is not shown. A model can invent a plausible sentence; it can't make that sentence appear in Article 2.
- **Fallback.** If Claude fails or times out, OpenAI answers, then Gemini. The model that answered is logged.

Example response (shape):

```json
{
  "status": "success",
  "data": {
    "found": true,
    "answer": "Est commerçant celui qui fait de l'accomplissement d'actes de commerce par nature sa profession (art. 2) …",
    "citations": [
      { "document": "Acte uniforme OHADA du 15 décembre 2010 …", "article": "2", "pages": [3, 3],
        "quote": "fait de l'accomplissement d'actes de commerce par nature sa profession" }
    ],
    "confidence": "high",
    "language": "fr"
  }
}
```

### The chunker: the core of the project

Legal answers have to cite an **article**, so DocuLex never splits by fixed size. `src/services/chunker.service.ts` is a pure function with no database and no PDF library, covered by 25 unit tests. It:

- **Finds article headings** (`Article 1er`, `Art.2.-`, `ARTICLE 12 bis`, `Article 35-1`) only at the start of a line, and only if they follow the article sequence. That skips the table of contents and mid-sentence references like *« conformément à l'article 28 »*.
- **Tracks the page range** of every article, including articles that cross a page break.
- **Cleans PDF artefacts:** repeated headers and footers (including headers that alternate between odd and even pages), words cut by a hyphen at the end of a line (`commercia-\nles` becomes `commerciales`, while `non-commerçant` keeps its hyphen), bullet glyphs, page numbers and NUL characters.
- **Builds a section path** for each article, such as *Livre 1 > Titre 1 > Chapitre 2 - Capacité d'exercer le commerce*. It handles headings placed after an article (French Act) and right after the article line (English Act). The path is embedded together with the article text.
- **Splits long articles** (over 800 tokens) at sentence ends. Every part keeps its article number.

On the two Acts used so far: **307 articles found in the AUDCG 2010 (French)**, with no gaps, and **919 in the Companies Act 1997 (English)**. The only gap there is Art. 705, which is missing from the PDF's own text.

---

## Results

Measured with `src/scripts/eval-retrieval.ts` on a hand-written set of bilingual questions (`eval/questions.json`). The expected articles were checked against the PDFs. **Hit@5** = the expected article is among the first 5 results.

### Vector-only vs hybrid search

23 in-document questions: 11 French, 12 English, about half asked in a different language from their document.

| Mode | Hit@5 |
| --- | --- |
| **Vector only (pgvector, cosine)** | **20 / 23** |
| Hybrid, keyword weight 0.25, same language | 19 / 23 |
| Hybrid, keyword weight 0.5, same language | 18 / 23 |
| Hybrid, keyword weight 0.25, both languages | 18 / 23 |
| Hybrid, keyword weight 1, same language | 17 / 23 |
| Hybrid, keyword weight 1, both languages | 16 / 23 |

*Measured on 5 Nov 2026. Two of the vector "misses" (#23, #25) were labelling errors in the question set, where the correct article was returned at rank 1. Both are now fixed in `questions.json`, and the next run will replace these numbers.*

**Decision:** v1 uses vector-only retrieval. Hybrid search stays in the code (`hybridSearch`), with its tests, behind a flag, so the comparison can be rerun.

**Why hybrid lost:**

1. **Postgres `ts_rank` has no IDF.** Frequent legal words (*company, commerçant, acte, uniforme*) counted as much as rare ones. A document-frequency filter (`lexeme_stats`, which drops words found in more than 10% of chunks) fixed the ranking itself: for *"maximum duration of a company"*, Art. 28 went to rank 1. Fusion still did not beat vectors.
2. **Keyword search can't cross languages.** An English question about a French article has no words in common with it. Limiting keyword search to the question's language helped same-language questions but hurt cross-language ones.

**Next step:** translate the question before keyword search. That is one cheap LLM call, and it is the only change likely to make hybrid search worthwhile.

### Relevance threshold (for `found: false`)

| | Top cosine similarity |
| --- | --- |
| Lowest, in-document hit | 0.663 |
| Highest, out-of-document | 0.652 |

The two ranges almost touch, so a similarity cutoff alone can't separate answerable from unanswerable questions. Hence two layers: a low cutoff (0.60) that rejects clear noise without calling the LLM, then the LLM itself returns `found: false` when the retrieved articles don't contain the answer. The question set has 8 out-of-document questions to measure both layers.

### Answer quality (`/ask`)

Measured with `src/scripts/eval-answers.ts`, which runs the real pipeline on the same 31 questions. **No second LLM grades the answers.** The grade uses only facts the pipeline already checked:

| Question | Verdict | Rule |
| --- | --- | --- |
| In-document | **correct** | Answered, and at least one citation names an expected article of the expected Act. Citations have passed quote verification, so this means "grounded in verbatim text of the right article". |
| In-document | wrong article | Answered, but every citation names another article. Read by hand: it can be a labelling error. |
| In-document | missed | Refused. Split by layer, and by whether the expected article was among the sources: if it was, it's a generation miss; if not, a retrieval miss. |
| Out-of-document | **refused** | `found: false`, split by layer (`threshold` / `llm` / `no_valid_citation`). |
| Out-of-document | answered | A failure: the answer is printed for review. |
| Any answered | language | The answer is in the language of the question (rule 4 of the prompt). |

What this does not check: whether the sentence itself is right. The script prints every miss with its `expected_answer_summary` next to the answer, to be read by hand. It also reports mean, p50 and p95 latency, cost per LLM call, and which model answered.

| | Result |
| --- | --- |
| In-document answered with an expected article | *to be measured* / 23 |
| Out-of-document refused | *to be measured* / 8 (threshold · llm) |
| Answers in the question's language | *to be measured* |
| Latency (p50 / p95) | *to be measured* |
| Cost per LLM call | *to be measured* (prices in `src/config/prices.ts` are placeholders until production) |

---

## Design choices

| Choice | Why |
| --- | --- |
| **Chunk by article, not by size** | Citations must name an article; a fixed-size window cuts articles in half and mixes neighbours. |
| **Section path in the embedding** | Articles like *"Nul ne peut accomplir des actes de commerce… s'il n'est juridiquement capable"* only mention "capacity" in their chapter title. |
| **Postgres + pgvector, one database** | Text, vectors, full-text and filters in one place; no separate vector store to sync. |
| **Drizzle over Prisma** | Native `vector` type, HNSW index and generated `tsvector` columns declared in the schema; Prisma would need raw SQL for all of them. |
| **1536-dimension embeddings** | pgvector's HNSW index supports at most 2000 dimensions for `vector`. |
| **`ORDER BY distance`, not `similarity DESC`** | Postgres only uses the HNSW index when sorting by the distance operator itself. |
| **Vector-only in v1** | Measured: every hybrid setting scored lower (see Results). |
| **Admin API key compared with `timingSafeEqual`** | Avoids leaking the key through response timing. |
| **Upload limits in multipart, PDF checked by magic bytes** | The 20 MB limit stops reading before buffering; the client's `mimetype` can be faked, `%PDF-` cannot. |
| **LLM always mocked in tests** | Tests stay fast, free and deterministic; quality is measured separately by the eval scripts. |
| **Two refusal layers** | The threshold is free and stops clear noise; the LLM catches near misses the threshold can't separate (see the relevance threshold above). |
| **Citations by source number + quote verification** | The model cites `source: 1`, never an article number it could invent; the server maps it to document, article and pages, and drops any quote not found in that source. |
| **Minimum quote length (20 characters)** | An empty quote is a substring of every text; a short one (*"de commerce"*) matches most articles. Neither proves anything. |
| **Three-model fallback (Claude → OpenAI → Gemini)** | Providers fail independently; an answer from the fallback beats a 500. The model that answered is logged. |
| **One `queries` row per question, every path** | Each refusal layer, error rate, cost and latency can be measured from production data, not guessed. Logging failures are reported but never break an answer. |
| **Answer eval without an LLM judge** | A judge would be a second model to trust and pay for. Verified citations to expected articles are deterministic; the meaning is checked by reading the printed misses. |
| **Rate limit on `/ask` only, 10 / min / IP (`@fastify/rate-limit`)** | `/ask` is the only route that costs money. Fixed window per IP, kept in memory (one process on one VPS). The library bounds memory with an LRU and sends `retry-after`, which a hand-written `Map` would not. |
| **`trustProxy` set to the proxy's address, not `true`** | Behind nginx every request comes from the proxy; as the container sees it, that is the Docker network's gateway (`172.28.50.1`), not `127.0.0.1`. Without it all clients share one rate-limit bucket; trusting any proxy would let a client fake `X-Forwarded-For`. |
| **Global error handler, `requestId` in every error** | 5xx responses never contain SQL, query parameters, stack traces or provider messages; the full error (with a Drizzle error's `cause`) is logged under the same request id. |
| **`ON DELETE CASCADE` on `chunks.document_id`** | Deleting a document is one atomic statement; no orphan chunks if the second of two deletes fails. |

### Things that went wrong, and what they taught

- **The question set was wrong before the search was.** Expected articles came from the 1997 AUDCG, while the PDF ingested was the 2010 revision, where the numbers changed. 4 "misses" were labelling errors. Every expected article is now checked against the uploaded PDF.
- **An `UPDATE` without `WHERE`** in the first backfill script would have written one vector onto every chunk. It was caught before running.
- **PostgreSQL 17 runs materialized-view queries with a restricted `search_path`**, so `ts_stat('SELECT … FROM chunks')` failed until written as `public.chunks`.
- **Postgres guessed a parameter type from context:** `count(*) * $1` made `$1` a `bigint`, so `0.1` failed until cast with `::float8`.
- **A PDF without a Unicode character map** produced NUL characters that Postgres rejects in `text` columns.
- **The first migration was empty.** `0000_enable_pgvector.sql` never contained `CREATE EXTENSION vector`; the dev database had it from a manual step. The first fresh database (for tests) failed at `type "vector" does not exist`, and so would the VPS. CI now migrates a fresh database on every push.
- **The integration tests never ran in CI.** The README said they did, but `RUN_DB_TESTS` was never set, and a moved test file still mocked a wrong path. Nothing failed, because nothing ran.
- **An empty quote passed verification:** `"any text".includes("")` is `true`. Caught while writing the unit tests, before any real traffic.
- **Vitest on Windows** loaded itself twice when the project was opened as `c:\` instead of `C:\`, and every suite failed with `Cannot read properties of undefined (reading 'config')`.

---

## API

All routes are under `/api`. Responses use one shape: `{ status: "success", data }` or `{ status: "failed", message, errors?, requestId? }`. Every error raised outside a controller (invalid JSON, rate limit, server errors) carries a `requestId` that matches the server log; a 5xx only ever says `Internal server error`.

| Method + path | Auth | Description |
| --- | --- | --- |
| `GET /api/health` | None | Database (pgvector installed) and LLM provider status; `503` if the database is down, `degraded` if only the LLM is |
| `POST /api/documents/upload` | `x-api-key` | Multipart: `file` (PDF, max 20 MB), `title`, `language` (`fr`\|`en`), `sourceUrl?` → stored document |
| `GET /api/documents` | None | List documents |
| `GET /api/documents/:documentId/show` | None | One document |
| `DELETE /api/documents/:documentId/delete` | `x-api-key` | Delete a document and its chunks; `422` if the id isn't a uuid, `404` if no such document |
| `POST /api/ai/ask` | None | `{ question }` (3–1000 characters) → `{ found, answer, citations[], confidence, language }`; `422` invalid, `429` over 10 requests / minute / IP |

```bash
curl -X POST http://localhost:3000/api/ai/ask -H "content-type: application/json" \
  -d '{"question": "Quelles sont les conditions pour avoir la qualité de commerçant ?"}'
```

---

## Run locally

Requirements: Node.js 22 (see `.nvmrc`) and Docker.

```bash
git clone <repo-url> doculex && cd doculex
npm ci
cp .env.example .env          # then fill in the keys (see below)
docker compose up -d          # Postgres 17 + pgvector on port 5433
npm run db:migrate
npm run dev                   # http://localhost:3000/api/health
```

Upload a document:

```bash
curl -X POST http://localhost:3000/api/documents/upload \
  -H "x-api-key: $ADMIN_API_KEY" \
  -F "title=Acte uniforme OHADA du 15 décembre 2010 portant sur le droit commercial général" \
  -F "language=fr" \
  -F "file=@./ohada-acte-uniforme-2010-droit-commercial.pdf"
```

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | Yes | e.g. `postgres://doculex:doculex@localhost:5433/doculex` |
| `ADMIN_API_KEY` | Yes | At least 32 characters; protects write endpoints |
| `EMBEDDING_MODEL` | Yes | Embedding model id |
| `GEMINI_API_KEY` | Yes | Embeddings, and the last fallback model |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Yes | Primary and second answer models |
| `LLM_MODEL` | Yes | Primary answer model (Anthropic), e.g. `claude-haiku-5-5` |
| `LLM_2ND_MODEL` | Yes | Second model (OpenAI), used if the primary fails |
| `LLM_FALLBACK_MODEL` | Yes | Last model (Gemini) |
| `MIN_SIMILARITY` | Yes | Layer-1 cutoff; below it `/ask` refuses without calling the LLM (`0.6`) |
| `LLM_PROVIDER` | No | `anthropic` \| `openai` \| `google`, for the health check |
| `TRUST_PROXY` | No | Address of the reverse proxy as the app sees it; set in `deploy/docker-compose.prod.yml` (`172.28.50.1`). Unset in development |
| `EMBEDDING_PARALLEL_CALLS` | No | Default `2`, gentle on free-tier rate limits |
| `PORT` | No | Default `3000` |
| `TEST_DATABASE_URL` / `RUN_DB_TESTS` | Tests only | A separate, migrated database for the Postgres integration tests, and `1` to run them |

The model names must match the keys of `src/config/prices.ts`, or `cost_usd` is logged as `null`.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with reload |
| `npm test` | Vitest (with `RUN_DB_TESTS=1` and `TEST_DATABASE_URL`, also the Postgres integration tests) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run db:generate -- --name=<change>` | New migration from `schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run documents:evaluate-retrieval -- --mode vector` | Retrieval evaluation (`vector` \| `keyword` \| `hybrid`, `--kw-weight`, `--same-lang`) |
| `npm run documents:evaluate-answers` | Answer evaluation through the real `/ask` pipeline (`--ids 1,2`, `--show-all`, `--out file.json`). Calls the LLM: costs money, and writes to `queries` |
| `npm run documents:embed-missing` | Embed chunks that have no vector yet |

### Tests

95 test cases. The LLM and the embedding provider are always mocked; only the eval scripts call them for real.

| Suite | Tests | Covers |
| --- | --- | --- |
| Chunker | 25 | Headings, page ranges, header/footer and hyphen cleaning, section paths, long-article splits |
| Search | 16 | 9 unit (RRF, language detection, de-duplication) + 7 against real Postgres + pgvector |
| Ask service | 11 | Every `stopped_at` path, citation mapping, the three-model fallback, a failed log insert |
| Answer helpers | 11 | Quote verification (missing source, wrong quote, empty/short quote, normalisation) and cost |
| `/ask` route | 10 | `422`, `429` per IP (invalid requests count too), other routes unlimited, no leak in a `500` |
| Answer grading | 9 | Eval verdicts, percentiles, summary |
| Upload route | 7 | `401`, `422`, `413`, `201`, `500` without internals |
| Delete route | 3 | `422`, `404`, `200` |
| Health | 3 | `ok`, `degraded`, `503` |

Locally, the integration tests need their own database (never the dev one: they insert fixtures and rank over every chunk):

```bash
docker exec pgvector-db createdb -U doculex doculex_test
DATABASE_URL=postgres://doculex:doculex@localhost:5433/doculex_test npm run db:migrate
# then in .env: TEST_DATABASE_URL=postgres://doculex:doculex@localhost:5433/doculex_test and RUN_DB_TESTS=1
```

In CI, a `pgvector/pgvector:pg17` service starts empty: every migration is applied from zero, then the whole suite runs, integration tests included.

---

## Project layout

```
src/
  routes/        URL → controller mapping, API-key group
  controllers/   validate input, call services, shape responses
  services/      chunker, documents (ingest), embeddings, search, ask (pipeline + fallback),
                 answer (prompt, schema, quote verification), queries (log), health
  middleware/    requireAdminKey
  config/        env (Zod-validated), prices per model
  db/            Drizzle schema and client
  scripts/       eval-retrieval, eval-answers (+ lib/answer-grading), embed-missing
  utils/         Zod schemas, validator, response helpers, error handler
drizzle/         SQL migrations (including the custom pgvector and lexeme_stats ones)
eval/            questions.json: the evaluation set
test/            Vitest suites: api/ (routes), services/, scripts/
```

---

## Next steps

**Phase 1 (v1, by end of November)**

- ~~`/ask` with verified citations, two-layer `found: false`, model fallback, rate limit, query log, error handler, cascade delete~~ (Weekend 5, done)
- Run the answer eval and fill in the Answer quality table; tune `MIN_SIMILARITY` with it
- One overall deadline for the fallback chain: today each of the 3 models gets 20 s, so the worst case is about a minute
- Real prices in `src/config/prices.ts` before production
- Deploy to a VPS from GitLab CI: Docker image per commit, nginx + HTTPS in front (see `deploy/README.md`)
- Query translation for cross-language keyword search, then re-measure hybrid

**Phase 2 (v2, December–January)**

- Court decisions (CCJA and Cameroonian courts): upload, LLM metadata extraction with human review, anonymisation of personal names
- Links from each article to the decisions that cite it; filtered case-law search

**Not planned for v1:** user accounts, a polished frontend (a separate Next.js app comes in Phase 3), re-ranking models, OCR for scanned PDFs.

---

*DocuLex is a research tool, not legal advice.*