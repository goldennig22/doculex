// test/services/chunker.service.test.ts
import { describe, it, expect } from 'vitest';
import {
  chunkByArticle,
  cleanPageText,
  embeddingText,
  normalizeRef,
  selectHeadings,
  stripRepeatedLines
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
  it('never returns the same article twice', () => {
    const text = 'Article 1er\nA.\nArticle 2\nB.\nArticle 2 bis\nC.\nArticle 2\nrenvoi.\nArticle 3\nD.';
    expect(selectHeadings(text).map((h) => h.ref)).toEqual(['1', '2', '2 bis', '3']);
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
    expect(parts[1].content.startsWith('[Article 1, part 2]')).toBe(true);
    expect(parts[0].content.startsWith('Article 1er')).toBe(true);
    for (const p of parts) expect(p.tokenCount <= 800).toBe(true);
  });

  it('returns an empty array when there is no article', () => {
    expect(chunkByArticle([{ page: 1, text: 'Aucun article ici.' }])).toEqual([]);
  });
});

describe('cleanPageText', () => {
  it('joins a word cut by a hyphen at the end of a line', () => {
    expect(cleanPageText('sociétés commercia-\nles et uni-\nforme')).toBe('sociétés commerciales et uniforme');
  });
  it('keeps the hyphen of a real compound word', () => {
    expect(cleanPageText('personnes non-\ncommerçantes')).toBe('personnes non-commerçantes');
  });
  it('turns bullet glyphs into dashes', () => {
    expect(cleanPageText('\uF0B7 de l’article 5')).toBe('- de l’article 5');
  });
  it('removes NUL and control characters that Postgres rejects', () => {
    expect(cleanPageText('Art.1.-\u0000 Tout\u0001 commerçant')).toBe('Art.1.- Tout commerçant');
  });
  it('removes lines that are only a page number or a roman tab marker', () => {
    expect(cleanPageText('fin de page.\n117\nIV\nsuite')).toBe('fin de page.\n\n\nsuite');
  });
});

describe('stripRepeatedLines with alternating headers', () => {
  it('removes headers that alternate between odd and even pages', () => {
    const odd = 'COMPILATION OF TREATIES AND UNIFORM ACTS';
    const even = 'UNIFORM ACT RELATING TO COMMERCIAL COMPANIES';
    const bodies = ['Alpha text.', 'Beta text.', 'Gamma text.', 'Delta text.', 'Epsilon text.', 'Zeta text.'];
    const pages = bodies.map((b, i) => ({ page: i + 1, text: `${i % 2 ? even : odd}\n${b}` }));
    const out = stripRepeatedLines(pages).map((p) => p.text.trim());
    expect(out).toEqual(bodies);
  });
});

describe('section path', () => {
  it('moves French headings from the end of an article to the next one', () => {
    const chunks = chunkByArticle([{
      page: 1,
      text: [
        'Art.5.- Les actes de commerce se prouvent par tous moyens.',
        'Chapitre 2 - Capacité d’exercer le commerce',
        'Art.6.- Nul ne peut accomplir des actes de commerce s’il n’est capable.',
      ].join('\n'),
    }]);
    const [art5, art6] = chunks;
    expect(art5.content.includes('Chapitre 2')).toBe(false);
    expect(art6.sectionPath).toBe('Chapitre 2 - Capacité d’exercer le commerce');
  });

  it('reads English headings that come right after the article line', () => {
    const chunks = chunkByArticle([{
      page: 1,
      text: [
        'ARTICLE 1', 'Scope text.',
        'PART 1', 'GENERAL PROVISIONS', 'BOOK 1', 'FORMATION OF A COMPANY',
        'ARTICLE 2', '', 'TITLE 1', 'DEFINITION OF THE COMPANY', '', 'A company shall be formed by two persons.',
        'ARTICLE 3', '', 'Section 1', 'Registered capital', '', 'The capital shall be one million.',
      ].join('\n'),
    }]);
    const [, art2, art3] = chunks;
    expect(art2.sectionPath).toBe('PART 1 GENERAL PROVISIONS > BOOK 1 FORMATION OF A COMPANY > TITLE 1 DEFINITION OF THE COMPANY');
    expect(art2.content).toBe('ARTICLE 2\nA company shall be formed by two persons.');
    expect(art3.sectionPath?.endsWith('TITLE 1 DEFINITION OF THE COMPANY > Section 1 Registered capital')).toBe(true);
    expect(art3.content).toBe('ARTICLE 3\nThe capital shall be one million.');
  });

  it('a new Livre clears the Titre and Chapitre below it', () => {
    const chunks = chunkByArticle([{
      page: 1,
      text: [
        'Livre 1 - Statut', 'Titre 1 - Commerçant', 'Chapitre 1 - Définition',
        'Art.1.- Un.',
        'Livre 2 - Registre',
        'Art.2.- Deux.',
      ].join('\n'),
    }]);
    expect(chunks[0].sectionPath).toBe('Livre 1 - Statut > Titre 1 - Commerçant > Chapitre 1 - Définition');
    expect(chunks[1].sectionPath).toBe('Livre 2 - Registre');
  });

  it('a one-line article followed by headings keeps them for the next article', () => {
    const chunks = chunkByArticle([{
      page: 1,
      text: 'Art.1.- Texte en une ligne.\nLivre 6 - Bail\nTitre 1 - Bail à usage professionnel\nArt.2.- Suite.',
    }]);
    expect(chunks[0].content).toBe('Art.1.- Texte en une ligne.');
    expect(chunks[0].sectionPath).toBe(null);
    expect(chunks[1].sectionPath).toBe('Livre 6 - Bail > Titre 1 - Bail à usage professionnel');
  });

  it('embeddingText puts the section path above the content', () => {
    expect(embeddingText({ sectionPath: 'Chapitre 2 - Capacité', content: 'Art.6.- …' })).toBe('Chapitre 2 - Capacité\nArt.6.- …');
    expect(embeddingText({ sectionPath: null, content: 'Art.1.- …' })).toBe('Art.1.- …');
  });
});