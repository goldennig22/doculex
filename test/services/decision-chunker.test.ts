import { describe, it, expect } from 'vitest';
import { chunkDecision, findCaption, findSections, sectionRank } from '../../src/services/decision-chunker.service';
import type { PageText } from '../../src/interfaces/types';

// The layout of a CCJA judgment, with placeholders for the parties and numbers (not a real case).
const CAPTION = `COUR COMMUNE DE JUSTICE ET D'ARBITRAGE (CCJA)
Première chambre
Audience publique du 28 février 2019
Pourvoi n° 000/2016/PC du 10/05/2016
Affaire : Société Alpha SA (Conseil : Maître Beta)
contre
Société Gamma SARL
Arrêt N° 000/2019 du 28 février 2019
La Cour Commune de Justice et d'Arbitrage (CCJA), Première chambre, a rendu l'Arrêt suivant :`;

const PROCEDURE = `Sur le recours enregistré au greffe de la Cour le 10 mai 2016 sous le n° 000/2016/PC et formé par la Société Alpha SA,
en cassation de l'arrêt n° 00/CIV rendu le 15 janvier 2016 par la Cour d'appel du Littoral à Douala, dont le dispositif est le suivant :
PAR CES MOTIFS : Statuant publiquement, contradictoirement, en matière civile et commerciale, en appel et en dernier ressort ;
Confirme le jugement entrepris ;
Vu les articles 13 et 14 du Traité relatif à l'harmonisation du droit des affaires en Afrique ;`;

const FAITS = `Attendu, selon l'arrêt attaqué, que la Société Alpha SA, se prévalant de la qualité de commerçant de son débiteur,
a assigné celui-ci en paiement devant le tribunal de première instance ;`;

const MOYEN_1 = `Sur le premier moyen, tiré de la violation de l'article 7 de l'Acte uniforme portant sur le droit commercial général
Attendu qu'il est fait grief à l'arrêt d'avoir retenu la qualité de commerçant d'un mineur non émancipé ;
Mais attendu que l'arrêt relève que le défendeur était émancipé à la date des actes litigieux ;
Qu'il échet de rejeter ce moyen ;`;

const MOYEN_2 = `Sur le second moyen
Attendu qu'il est reproché à l'arrêt un défaut de base légale ;
Mais attendu que ce moyen manque en fait ; qu'il échet de le rejeter ;`;

const DEPENS = `Sur les dépens
Attendu que la Société Alpha SA ayant succombé, sera condamnée aux dépens ;`;

const DISPOSITIF = `PAR CES MOTIFS :
Statuant publiquement, après en avoir délibéré,
Rejette le pourvoi formé par la Société Alpha SA ;
La condamne aux dépens.`;

const SIGNATURES = `Ainsi fait, jugé et prononcé les jour, mois et an que dessus et ont signé :
Le Président
Le Greffier`;

const JUDGMENT = [CAPTION, PROCEDURE, FAITS, MOYEN_1, MOYEN_2, DEPENS, DISPOSITIF, SIGNATURES].join('\n');
const text = (full: string, s: { start: number; end: number }) => full.slice(s.start, s.end).trim();

describe('findSections (French CCJA judgment)', () => {
  const spans = findSections(JUDGMENT, 'fr');

  it('finds every section in reading order', () => {
    expect(spans.map((s) => s.ref)).toEqual(['procedure', 'faits', 'moyen-1', 'moyen-2', 'depens', 'dispositif']);
  });

  it('drops the caption: the party names before "a rendu l\'Arrêt suivant" are in no section', () => {
    expect(spans.every((s) => !text(JUDGMENT, s).includes('Conseil : Maître Beta'))).toBe(true);
    expect(text(JUDGMENT, spans[0]).startsWith('Sur le recours')).toBe(true);
  });

  it("takes the LAST \"PAR CES MOTIFS\": the first one quotes the lower court's decision", () => {
    const dispositif = spans.find((s) => s.ref === 'dispositif')!;
    expect(text(JUDGMENT, dispositif)).toContain('Rejette le pourvoi');
    expect(text(JUDGMENT, dispositif)).not.toContain('Confirme le jugement entrepris');
    expect(text(JUDGMENT, spans[0])).toContain('Confirme le jugement entrepris'); // stays in the procedure
  });

  it("keeps a party's grievance and the court's answer in the same moyen", () => {
    const moyen = text(JUDGMENT, spans.find((s) => s.ref === 'moyen-1')!);
    expect(moyen).toContain('il est fait grief');
    expect(moyen).toContain('Mais attendu que');
    expect(moyen).not.toContain('Sur le second moyen');
  });

  it('labels a moyen with its heading line', () => {
    expect(spans.find((s) => s.ref === 'moyen-1')!.label)
      .toBe("Sur le premier moyen, tiré de la violation de l'article 7 de l'Acte uniforme portant sur le droit…"); // 100 chars max, cut at a word
    expect(spans.find((s) => s.ref === 'moyen-2')!.label).toBe('Sur le second moyen');
  });

  it('cuts the signatures off the dispositif', () => {
    expect(text(JUDGMENT, spans.at(-1)!)).not.toContain('Ainsi fait');
  });

  it('does not take "moyen" inside a sentence for a heading', () => {
    const withSentence = JUDGMENT.replace(MOYEN_2, `${MOYEN_2}\nAttendu que, sur le premier moyen invoqué, la Cour a statué ;`);
    expect(findSections(withSentence, 'fr').filter((s) => s.section === 'moyen')).toHaveLength(2);
  });

  it('numbers joined moyens as one: "Sur les premier et deuxième moyens réunis"', () => {
    const joined = JUDGMENT.replace(MOYEN_1, MOYEN_1.replace('Sur le premier moyen', 'Sur les premier et troisième moyens réunis'));
    expect(findSections(joined, 'fr').filter((s) => s.section === 'moyen').map((s) => s.ref)).toEqual(['moyen-1', 'moyen-2']);
  });

  it('returns [] when the text has no structure at all', () => {
    expect(findSections('Une simple note sans aucune structure de décision.', 'fr')).toEqual([]);
  });
});

describe('findSections (English)', () => {
  it('finds facts, grounds and the operative part', () => {
    const judgment = [
      'The Court has rendered the following judgment:',
      'On the appeal lodged by Alpha Ltd against judgment No. 00 of the Court of Appeal of the South West Region;',
      'THE FACTS',
      'Alpha Ltd sued Gamma Ltd for payment of a debt arising from a commercial lease.',
      'On the first ground of appeal',
      'Whereas the appellant contends that article 101 was violated; but whereas the lease was renewed;',
      'FOR THESE REASONS',
      'Dismisses the appeal.',
      'Thus done and delivered in open court.',
    ].join('\n');
    expect(findSections(judgment, 'en').map((s) => s.ref)).toEqual(['procedure', 'faits', 'moyen-1', 'dispositif']);
  });
});

describe('chunkDecision', () => {
  const pages: PageText[] = [
    { page: 1, text: [CAPTION, PROCEDURE, FAITS].join('\n') },
    { page: 2, text: [MOYEN_1, MOYEN_2, DEPENS, DISPOSITIF, SIGNATURES].join('\n') },
  ];
  const drafts = chunkDecision(pages, { lang: 'fr', pathPrefix: 'CCJA > Première chambre > Arrêt n° 000/2019' });

  it('makes one chunk per section and drops the costs', () => {
    expect(drafts.map((d) => d.articleRef)).toEqual(['procedure', 'faits', 'moyen-1', 'moyen-2', 'dispositif']);
    expect(drafts.every((d) => d.part === 0)).toBe(true);
  });

  it('puts the section in the path that is embedded with the chunk', () => {
    expect(drafts.find((d) => d.articleRef === 'faits')!.sectionPath).toBe('CCJA > Première chambre > Arrêt n° 000/2019 > Faits');
    expect(drafts.find((d) => d.articleRef === 'moyen-2')!.sectionPath).toBe('CCJA > Première chambre > Arrêt n° 000/2019 > Sur le second moyen');
  });

  it('records the page of each section', () => {
    expect(drafts.find((d) => d.articleRef === 'faits')).toMatchObject({ pageStart: 1, pageEnd: 1 });
    expect(drafts.find((d) => d.articleRef === 'dispositif')).toMatchObject({ pageStart: 2, pageEnd: 2 });
  });

  it('splits a long moyen into labelled parts that keep its ref', () => {
    const longMoyen = `Sur le premier moyen\n${'Attendu que la Cour relève un fait déterminant pour la solution du litige ;\n'.repeat(80)}`;
    const long = chunkDecision([{ page: 1, text: [CAPTION, longMoyen, DISPOSITIF].join('\n') }], { lang: 'fr', pathPrefix: 'CCJA' });
    const parts = long.filter((d) => d.articleRef === 'moyen-1');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((p) => p.part)).toEqual(parts.map((_, i) => i));
    expect(parts[1].content.startsWith('[Sur le premier moyen, part 2]\n')).toBe(true);
  });

  it('falls back to size-based chunks under "texte" when no structure is found', () => {
    const plain = chunkDecision([{ page: 1, text: 'Décision au format inhabituel. '.repeat(20) }], { lang: 'fr', pathPrefix: 'CCJA' });
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((d) => d.articleRef === 'texte')).toBe(true);
    expect(plain[0].sectionPath).toBe('CCJA > Texte intégral');
  });

  it('returns [] for a PDF without text (scanned)', () => {
    expect(chunkDecision([{ page: 1, text: '' }, { page: 2, text: '  \n' }], { lang: 'fr', pathPrefix: 'CCJA' })).toEqual([]);
  });
});

describe('findCaption', () => {
  it('returns the text up to "a rendu l\'Arrêt suivant", with court, chamber, case number and date', () => {
    const caption = findCaption([{ page: 1, text: JUDGMENT }], 'fr');
    expect(caption).toContain("COUR COMMUNE DE JUSTICE ET D'ARBITRAGE (CCJA)");
    expect(caption).toContain('Arrêt N° 000/2019 du 28 février 2019');
    expect(caption?.endsWith("a rendu l'Arrêt suivant :")).toBe(true);
    expect(caption).not.toContain('Sur le recours');
  });

  it('cleans the caption like the chunks (joinPages), so quotes from it match the extraction input', () => {
    const pages = [{ page: 1, text: 'COUR COMMUNE DE JUSTICE ET D\'ARBITRAGE\nPremière cham-\nbre\na rendu l\'Arrêt suivant :\nSur le recours…' }];
    expect(findCaption(pages, 'fr')).toContain('Première chambre');
  });

  it('returns null without the marker, and for English (no reliable marker)', () => {
    expect(findCaption([{ page: 1, text: FAITS + MOYEN_1 }], 'fr')).toBeNull();
    expect(findCaption([{ page: 1, text: JUDGMENT }], 'en')).toBeNull();
  });
});

describe('sectionRank', () => {
  it('orders article refs in reading order, moyens by number', () => {
    const refs = ['dispositif', 'moyen-10', 'faits', 'moyen-2', 'procedure', 'competence-2', 'competence'];
    expect([...refs].sort((a, b) => sectionRank(a) - sectionRank(b)))
      .toEqual(['procedure', 'faits', 'competence', 'competence-2', 'moyen-2', 'moyen-10', 'dispositif']);
  });

  it('sorts unknown refs last', () => {
    expect(sectionRank('7')).toBeGreaterThan(sectionRank('dispositif'));
  });
});
