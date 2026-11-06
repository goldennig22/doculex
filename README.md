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
| 5 | `/ask`: cited answers with Claude, `found: false` refusal | Next |
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

  E --> DB[(Postgres + pgvector<br/>documents · chunks<br/>lexeme_stats)]

  subgraph Ask["Ask (public)"]
    Q[Question FR / EN] --> S[Vector search<br/>HNSW, cosine]
    S --> T{Relevant?}
    T -- no --> N[found: false]
    T -- yes --> L[LLM + Zod schema]
    L --> R[Answer with citations]
  end

  DB --> S
  DB -. measured, not used in v1 .-> K[Keyword search + RRF]

  classDef planned stroke-dasharray: 5 5;
  class T,N,L,R planned;
```

Dashed boxes are the Weekend 5 work (`/ask` with Claude). Today the ask endpoint returns the ranked articles.

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

The two ranges almost touch, so a similarity cutoff alone can't separate answerable from unanswerable questions. The plan for Weekend 5 has two layers: a low cutoff (~0.60) that rejects clear noise without calling the LLM, then the LLM itself must return `found: false` when the retrieved articles don't contain the answer. The question set now has 8 out-of-document questions to measure both layers.

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
| **LLM always mocked in tests** | Tests stay fast, free and deterministic; quality is measured separately by the eval script. |

### Things that went wrong, and what they taught

- **The question set was wrong before the search was.** Expected articles came from the 1997 AUDCG, while the PDF ingested was the 2010 revision, where the numbers changed. 4 "misses" were labelling errors. Every expected article is now checked against the uploaded PDF.
- **An `UPDATE` without `WHERE`** in the first backfill script would have written one vector onto every chunk. It was caught before running.
- **PostgreSQL 17 runs materialized-view queries with a restricted `search_path`**, so `ts_stat('SELECT … FROM chunks')` failed until written as `public.chunks`.
- **Postgres guessed a parameter type from context:** `count(*) * $1` made `$1` a `bigint`, so `0.1` failed until cast with `::float8`.
- **A PDF without a Unicode character map** produced NUL characters that Postgres rejects in `text` columns.

---

## API

All routes are under `/api`. Responses use one shape: `{ status: "success", data }` or `{ status: "failed", message, errors? }`.

| Method + path | Auth | Description |
| --- | --- | --- |
| `GET /api/health` | None | Database (pgvector installed) and LLM provider status; `503` if the database is down, `degraded` if only the LLM is |
| `POST /api/documents/upload` | `x-api-key` | Multipart: `file` (PDF, max 20 MB), `title`, `language` (`fr`\|`en`), `sourceUrl?` → stored document |
| `GET /api/documents` | None | List documents |
| `GET /api/documents/:documentId/show` | None | One document |
| `DELETE /api/documents/:documentId/delete` | `x-api-key` | Delete a document and its chunks |
| `POST /api/documents/questions/ask` | None | `{ question }` → ranked articles (Weekend 5: cited answer) |

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
| `GEMINI_API_KEY` | For embeddings | Embedding provider key |
| `LLM_PROVIDER` | No | `anthropic` \| `openai` \| `google` (health check and, from Weekend 5, answers) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | For answers | LLM provider key |
| `EMBEDDING_PARALLEL_CALLS` | No | Default `2`, gentle on free-tier rate limits |
| `PORT` | No | Default `3000` |

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with reload |
| `npm test` | Vitest (set `RUN_DB_TESTS=1` to include the Postgres integration tests) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run db:generate -- --name=<change>` | New migration from `schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npx tsx --env-file=.env src/scripts/eval-retrieval.ts --mode vector` | Retrieval evaluation (`vector` \| `keyword` \| `hybrid`, `--kw-weight`, `--same-lang`) |
| `npx tsx --env-file=.env src/scripts/embed-missing.ts` | Embed chunks that have no vector yet |

### Tests

52 test cases: the chunker (25), search (9 unit + 7 against real Postgres + pgvector), upload route (8) and health (3). The LLM and the embedding provider are always mocked; only the eval script calls them for real. In CI, a `pgvector/pgvector:pg17` service runs migrations and the integration tests.

---

## Project layout

```
src/
  routes/        URL → controller mapping, API-key group
  controllers/   validate input, call services, shape responses
  services/      chunker, documents (ingest), embeddings, search, health
  middleware/    requireAdminKey
  db/            Drizzle schema and client
  scripts/       eval-retrieval, embed-missing
  utils/         Zod schemas, validator, response helpers
drizzle/         SQL migrations (including the custom pgvector and lexeme_stats ones)
eval/            questions.json: the evaluation set
test/            Vitest suites
```

---

## Next steps

**Phase 1 (v1, by end of November)**

- `/ask`: Claude answers from retrieved articles only, Zod-validated `{ found, answer, citations[], confidence, language }`, two-layer `found: false`
- Fallback LLM provider, rate limit on `/ask`, every query logged with latency and cost
- Global error handler (no SQL or stack traces in responses), foreign key with cascade on `chunks.document_id`
- Deploy to a VPS over SSH from GitLab CI, HTTPS with Caddy
- Query translation for cross-language keyword search, then re-measure hybrid

**Phase 2 (v2, December–January)**

- Court decisions (CCJA and Cameroonian courts): upload, LLM metadata extraction with human review, anonymisation of personal names
- Links from each article to the decisions that cite it; filtered case-law search

**Not planned for v1:** user accounts, a polished frontend (a separate Next.js app comes in Phase 3), re-ranking models, OCR for scanned PDFs.

---

*DocuLex is a research tool, not legal advice.*