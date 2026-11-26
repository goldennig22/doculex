-- Word statistics over SEARCHABLE chunks only: statutes and published decisions.
-- Draft, in-review and rejected decisions must not change keyword ranking (MAX_DF in search.service.ts).
-- Same predicate as `searchable` in search.service.ts: change both together.
DROP MATERIALIZED VIEW IF EXISTS lexeme_stats;--> statement-breakpoint
CREATE MATERIALIZED VIEW lexeme_stats AS
  SELECT word, ndoc FROM ts_stat($q$
    SELECT c.content_tsv FROM public.chunks c
    JOIN public.documents d ON d.id = c.document_id
    WHERE d.kind = 'statute'
       OR EXISTS (SELECT 1 FROM public.decisions x WHERE x.document_id = d.id AND x.status = 'published')
  $q$);--> statement-breakpoint
CREATE UNIQUE INDEX lexeme_stats_word ON lexeme_stats (word);
