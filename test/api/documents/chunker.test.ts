// test/services/chunker.test.ts
import { describe, it, expect } from 'vitest';
import {
  chunkByArticle,
  normalizeRef,
  selectHeadings,
  stripRepeatedLines,
} from '../../../src/services/chunker.service';
import { PageText } from '../../../src/interfaces/documents';

const HEADER = 'Acte uniforme relatif au droit commercial général – Journal Officiel OHADA';
const page = (n: number, body: string): PageText => ({
  page: n,
  text: `${HEADER}\n${body}\nPage ${n}`,
});

describe('normalizeRef', () => {
  it('turns 1er and premier into "1"', () => {
    expect(normalizeRef('1er')).toBe('1');
    expect(normalizeRef('premier')).toBe('1');
  });
  it('joins a suffix in lower case', () => {
    expect(normalizeRef('12', 'BIS')).toBe('12 bis');
  });
});

describe('stripRepeatedLines', () => {
  it('removes a header and a footer repeated on most pages', () => {
    const pages = [page(1, 'Article 1er\nTexte un.'), page(2, 'Suite du texte.'), page(3, 'Article 2\nTexte deux.')];
    const out = stripRepeatedLines(pages);
    for (const p of out) {
      expect(p.text.includes(HEADER)).toBe(false);
      expect(p.text.includes('Page ')).toBe(false);
    }
  });
  it('never removes article headings, even when every page starts with one', () => {
    const bodies = ['Le commerçant tient ses livres.', 'Le registre est public.', 'Le bail est renouvelable.'];
    const pages = bodies.map((b, i) => ({ page: i + 1, text: `Article ${i + 1}\n${b}` }));
    const out = stripRepeatedLines(pages);
    expect(out.map((p) => p.text)).toEqual(pages.map((p) => p.text));
  });
});

describe('selectHeadings', () => {
  it('ignores a mid-sentence reference', () => {
    const text = 'Article 1er\nconformément à l\'article 28 ci-dessous.\nArticle 2\nTexte.';
    expect(selectHeadings(text).map((h) => h.ref)).toEqual(['1', '2']);
  });
  it('ignores a reference that happens to start a line but breaks the sequence', () => {
    const text = 'Article 1er\nTexte renvoyant à\narticle 28 du présent Acte.\nArticle 2\nTexte.';
    expect(selectHeadings(text).map((h) => h.ref)).toEqual(['1', '2']);
  });
  it('skips a table of contents and starts at the last Article 1', () => {
    const text = 'SOMMAIRE\nArticle 1er\nArticle 2\nArticle 3\nTITRE I\nArticle 1er\nTexte.\nArticle 2\nTexte.';
    const heads = selectHeadings(text);
    expect(heads.map((h) => h.ref)).toEqual(['1', '2']);
    expect(text.slice(heads[0].index).startsWith('Article 1er\nTexte.')).toBe(true);
  });
  it('accepts bis articles and hyphenated numbers', () => {
    const text = 'Article 1er\nA.\nArticle 1 bis\nB.\nArt. 2\nC.\nArticle 2-1\nD.';
    expect(selectHeadings(text).map((h) => h.ref)).toEqual(['1', '1 bis', '2', '2-1']);
  });
});

describe('chunkByArticle', () => {
  it('drops the preamble before the first article', () => {
    const chunks = chunkByArticle([{ page: 1, text: 'PRÉAMBULE\nLe Conseil des Ministres...\nArticle 1er\nTexte.' }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content.startsWith('Article 1er')).toBe(true);
  });

  it('records start and end page for an article that crosses a page break', () => {
    const chunks = chunkByArticle([
      { page: 14, text: 'Article 1er\nTexte court.\nArticle 2\nDébut de l\'article deux' },
      { page: 15, text: 'qui continue ici.\nArticle 3\nFin.' },
    ]);
    const art2 = chunks.find((c) => c.articleRef === '2')!;
    expect(art2.pageStart).toBe(14);
    expect(art2.pageEnd).toBe(15);
    expect(art2.content.includes('qui continue ici.')).toBe(true);
  });

  it('keeps the last article of the document', () => {
    const chunks = chunkByArticle([{ page: 1, text: 'Article 1er\nUn.\nArticle 2\nDeux, le dernier.' }]);
    expect(chunks.map((c) => c.articleRef)).toEqual(['1', '2']);
    expect(chunks[1].content.includes('le dernier')).toBe(true);
  });

  it('splits a long article into parts that keep the same articleRef', () => {
    const sentence = 'Le commerçant est tenu de tenir des livres comptables conformes aux règles en vigueur.\n';
    const longBody = sentence.repeat(60); // ~5,000 characters ≈ 1,300 tokens
    const chunks = chunkByArticle([{ page: 1, text: `Article 1er\n${longBody}Article 2\nCourt.` }]);
    const parts = chunks.filter((c) => c.articleRef === '1');
    expect(parts.length > 1).toBe(true);
    expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i));
    expect(parts[1].content.startsWith('Article 1 (suite)')).toBe(true);
    for (const p of parts) expect(p.tokenCount <= 800).toBe(true);
  });

  it('returns an empty array when there is no article', () => {
    expect(chunkByArticle([{ page: 1, text: 'Aucun article ici.' }])).toEqual([]);
  });
});