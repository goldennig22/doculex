CREATE MATERIALIZED VIEW lexeme_stats AS
  SELECT word, ndoc FROM ts_stat('SELECT content_tsv FROM public.chunks');
--> statement-breakpoint
CREATE UNIQUE INDEX lexeme_stats_word ON lexeme_stats (word);