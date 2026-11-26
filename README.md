# DocuLex

**Bilingual legal Q&A API for OHADA business law: ask in French or English, get the exact article it comes from.**

[![pipeline](https://gitlab.com/wambahermann084/doculex/badges/main/pipeline.svg)](https://gitlab.com/wambahermann084/doculex/-/pipelines)
<!-- TODO: placeholder domain, replace when the real one is live -->
**[Live demo](https://doculex-api.fleuva.com)** · **[API docs (Swagger)](https://doculex-api.fleuva.com/docs)**

<!-- TODO: 30-second demo GIF: one French question, one English question answered from a French article, one "not found"
![DocuLex demo](docs/demo.gif) -->

[OHADA](https://www.ohada.org) is the business law shared by 17 African countries, written as "Uniform Acts". DocuLex ingests those Acts (PDF), splits them **article by article**, and answers questions in French or English with citations to the exact article and pages. Every quote is checked word for word against the source, and when the answer isn't in the Acts, it says so instead of guessing.

| Measured on 42 hand-written questions | |
| --- | --- |
| Right article in the top 5 search results | **30 / 32** |
| Answered with a verified quote from the right article | **30 / 32** |
| Out-of-scope questions refused | **10 / 10** |
| Mean latency · cost per question | **2.9 s · $0.0004** |

How these were measured, and what they don't check, is in [Results](#results).

**Highlights**

- **Article-level chunking** of legal PDFs: a pure, unit-tested chunker that skips tables of contents and cross-references and cleans PDF artefacts.
- **Answers that can't invent their sources:** the model cites a source *number*, the server maps it to the article, and any quote not found verbatim in that article is dropped. Two refusal layers return `found: false` instead of an answer.
- **Decisions backed by measurement:** hybrid search (keywords + vectors) was built, measured, and lost to vector-only search, so it ships switched off.

Built with Node.js 22, TypeScript, Fastify, Postgres + pgvector, Drizzle ORM, the Vercel AI SDK (Claude, with OpenAI and Gemini as fallbacks) and Vitest. CI runs on [GitLab](https://gitlab.com/wambahermann084/doculex); the GitHub repository is a mirror.

**Why:** law students in Cameroon have no free place to read OHADA law next to the court decisions that apply it. Version 2 adds those decisions, linked to the articles they cite (see [Next steps](#next-steps)).

---

## Status

**v1 is deployed:** ingest, vector search, cited answers, CI to a VPS. A one-page demo at `/` and Swagger docs at `/docs`. **Next:** court decisions linked to articles (v2). Details in [Next steps](#next-steps).

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

All numbers below come from one run on 25 Nov 2026, on a hand-written question set (`eval/questions.json`):

- **32 in-document questions** (17 French, 15 English; 15 asked in the other language from the Act that answers them). Every expected article was checked against the text stored in the database.
- **10 out-of-document questions** (5 French, 5 English). Two are *near misses*: they ask about OHADA Acts that are not ingested (securities, insolvency), so they sound like the corpus but aren't in it.

**Hit@5** = an expected article is among the first 5 search results.

### Vector-only vs hybrid search

| Mode | Hit@5 |
| --- | --- |
| **Vector only (pgvector, cosine)** | **30 / 32** |
| Hybrid, keyword weight 0.5, both languages | 26 / 32 |

An earlier, wider sweep (5 Nov 2026, the first 23 questions) found the same order: vector-only first, and every hybrid setting (keyword weights 0.25 to 1, same-language or both) 1 to 4 questions behind.

The two vector misses: #17 asks in English about a French article and is the furthest question from any article (top similarity 0.620). #38 asks whether a private limited company can have a single member; search returned Art. 5 (*any* company may be formed by a single person) instead of the expected Art. 309, the SARL-specific rule.

**Decision:** v1 uses vector-only retrieval. Hybrid search stays in the code (`hybridSearch`), with its tests, behind a flag, so the comparison can be rerun.

**Why hybrid lost:**

1. **Postgres `ts_rank` has no IDF.** Frequent legal words (*company, commerçant, acte, uniforme*) counted as much as rare ones. A document-frequency filter (`lexeme_stats`, which drops words found in more than 10% of chunks) fixed the ranking itself: for *"maximum duration of a company"*, Art. 28 went to rank 1. Fusion still did not beat vectors.
2. **Keyword search can't cross languages.** An English question about a French article has no words in common with it. Limiting keyword search to the question's language helped same-language questions but hurt cross-language ones.

**Next step:** translate the question before keyword search. That is one cheap LLM call, and it is the only change likely to make hybrid search worthwhile.

### Relevance threshold (for `found: false`)

| | Top cosine similarity |
| --- | --- |
| Lowest, in-document | 0.620 (#17) |
| Highest, out-of-document | 0.675 (#41, a near miss) |

The two ranges **overlap**: a question about an Act that isn't ingested can sit closer to the corpus than a real question asked across languages. No similarity cutoff can separate them. Hence two layers: a low cutoff (0.60) that rejects clear noise without calling the LLM, then the LLM itself returns `found: false` when the retrieved articles don't contain the answer.

### Answer quality (`/ask`)

Measured with `src/scripts/eval-answers.ts`, which runs the real pipeline on the same 42 questions. **No second LLM grades the answers.** The grade uses only facts the pipeline already checked:

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
| In-document answered with an expected article | **30 / 32** |
| In-document wrongly refused | 1 (#17, by the LLM: the expected article was not in the sources) |
| In-document, other article cited | 1 (#38: cited Art. 5, see the vector misses above; the answer is true but not the expected article) |
| Out-of-document refused | **10 / 10**: 3 by the threshold, 7 by the LLM, 0 answered |
| Answers in the question's language | **30 / 31** (#37 was answered in another language; on a re-run it was answered in English, so the model is not fully consistent) |
| Latency | mean 2.9 s · p50 2.3 s · p95 6.2 s |
| Cost | $0.018 for the 42 questions: $0.00042 per question, $0.00046 per LLM call |
| Model that answered | Claude Haiku 5.5, 39 of 39 LLM calls (no fallback used) |

How to read latency and cost: the script calls the pipeline directly from a development machine (no HTTP, no nginx), so production adds network time. Cost is LLM tokens only, at the price in `src/config/prices.ts`; the question's embedding is not counted. Questions stopped by the threshold cost no LLM call.

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
| **API keys stored as SHA-256, with roles (admin > reviewer > contributor)** | A database leak gives no usable key. SHA-256, not bcrypt: a 256-bit random key cannot be guessed, and a deterministic hash can be looked up by index. The key is shown once by `npm run keys:create`. 401 = unknown or revoked key, 403 = valid key, role too low. The legacy `ADMIN_API_KEY` (compared with `timingSafeEqual`) still works on the statute routes until it is retired. |
| **Decisions chunked by section, one chunk per ground of appeal (moyen)** | A judgment has no "Article N". A size-based cut can separate a party's grievance from the court's answer, and the LLM would then present the losing argument as the holding. The last "PAR CES MOTIFS" is the dispositif (earlier ones quote the lower court). The caption (party names) and costs are not stored. |
| **Unpublished decisions are filtered inside every SQL query** | One predicate (`searchableDocuments`) used by vector search, keyword search, `getArticleParts`, the public document routes and `lexeme_stats`. Filtering after the search would still let a draft take a top-5 place and set `topSimilarity`. A DB test gives a draft similarity 1.0 and checks no search returns it. `/ask` stays statutes-only until an eval with published decisions. |
| **Upload limits in multipart, PDF checked by magic bytes** | The 20 MB limit stops reading before buffering; the client's `mimetype` can be faked, `%PDF-` cannot. |
| **Zod schemas on the routes, converted for OpenAPI (no `zod-to-json-schema`, no type-provider package)** | One definition validates the request, checks the response and generates the docs, so they can't drift apart. Zod 4 converts to JSON Schema itself; the glue is ~60 lines (`src/utils/zod-fastify.ts`). A response that breaks its schema is a 500 (our bug), never a 422. |
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
- **The admin key was checked after the upload was read.** The key check ran in `preHandler`, but `@fastify/multipart` parses the body earlier, in `preValidation`, so anyone could make the server buffer a 20 MB upload before getting a 401. A malformed body even returned a 500. The test called "401 before reading the body" never checked the second half of its name; a new test sends a broken multipart body without a key and expects 401. The check now runs in `onRequest`.
- **English questions answered in French.** The answer eval caught 10 of them, including questions about the English Act. The prompt asked for "the language of the question", but the server, which already detects it, never said which one it was. Passing the detected language in the prompt took the eval from 21 / 31 to 30 / 31 answers in the right language.
- **An empty quote passed verification:** `"any text".includes("")` is `true`. Caught while writing the unit tests, before any real traffic.
- **Vitest on Windows** loaded itself twice when the project was opened as `c:\` instead of `C:\`, and every suite failed with `Cannot read properties of undefined (reading 'config')`.

---

## API

Interactive docs with request and response examples (including `found: false`) are at **`/docs`**, generated from the same Zod schemas that validate requests and check responses. A small demo page is served at `/`.

All routes are under `/api`. Responses use one shape: `{ status: "success", data }` or `{ status: "failed", message, errors?, requestId? }`. An invalid request gets a `422` with `errors` by field. Every error raised outside a controller (validation, invalid JSON, rate limit, server errors) carries a `requestId` that matches the server log; a 5xx only ever says `Internal server error`.

| Method + path | Auth | Description |
| --- | --- | --- |
| `GET /api/health` | None | Database (pgvector installed) and LLM provider status; `503` if the database is down, `degraded` if only the LLM is |
| `POST /api/documents/upload` | `x-api-key` | Multipart: `file` (PDF, max 20 MB), `title`, `language` (`fr`\|`en`), `sourceUrl?` → stored document |
| `GET /api/documents` | None | List documents |
| `GET /api/documents/:documentId/show` | None | One document; `422` if the id isn't a uuid, `404` if no such document |
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
| `ADMIN_API_KEY` | Yes | At least 32 characters. Legacy admin key for the statute routes, until it is replaced by keys from `npm run keys:create -- --role admin --label "…"` |
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
  middleware/    requireRole (API keys with roles)
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
- ~~Run the answer eval and fill in the Answer quality table~~ (done, see Results)
- ~~Pass the question's language to the model explicitly~~ (done: 21 / 31 → 30 / 31 answers in the right language)
- One overall deadline for the fallback chain: today each of the 3 models gets 10 s, so the worst case is about 30 s
- Real prices for the two fallback models in `src/config/prices.ts` (the Claude price is real; the eval never reached a fallback)
- ~~Deploy to a VPS from GitLab CI: Docker image per commit, nginx in front (see `deploy/README.md`)~~ (done); HTTPS once the domain is set up
- ~~Swagger docs at `/docs`, generated from the Zod schemas; a one-page demo at `/`~~ (done)
- Query translation for cross-language keyword search, then re-measure hybrid

**Phase 2 (v2, December–January)**

- Court decisions (CCJA and Cameroonian courts): upload, LLM metadata extraction with human review, anonymisation of personal names
- Links from each article to the decisions that cite it; filtered case-law search

**Not planned for v1:** user accounts, a polished frontend (a separate Next.js app comes in Phase 3), re-ranking models, OCR for scanned PDFs.

---

*DocuLex is a research tool, not legal advice.*