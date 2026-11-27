import type { DetectedPersons } from '../../src/services/anonymisation/llm-detection';

// The layout of a CCJA judgment with natural persons in it. Every name is INVENTED: a fixture must never hold a
// real party's name, which is the whole point of anonymisation.
//   - TCHOUPO Jean-Marie: the party; in the caption, the procedure, the facts, the dispositif, and once with no title
//     inside a quote in the grounds ("« TCHOUPO, émancipé… »"), which no rule can find;
//   - NKOUM Paul: his counsel (Maître);
//   - NGO BIYONG Esther: his mother (Dame);
//   - "M. le Président de la Cour d'appel": a function, never a name.

export const CAPTION_WITH_PERSONS = `COUR COMMUNE DE JUSTICE ET D'ARBITRAGE (CCJA)
Première chambre
Audience publique du 28 février 2019
Pourvoi n° 000/2016/PC du 10/05/2016
Affaire : Monsieur TCHOUPO Jean-Marie (Conseil : Maître NKOUM Paul)
contre
Société Gamma SARL
Arrêt N° 045/2019 du 28 février 2019
La Cour Commune de Justice et d'Arbitrage (CCJA), Première chambre, a rendu l'Arrêt suivant :`;

export const PROCEDURE = `Sur le recours enregistré au greffe de la Cour le 10 mai 2016 sous le n° 000/2016/PC et formé par Monsieur TCHOUPO Jean-Marie, assisté de Maître NKOUM Paul, Avocat au Barreau du Cameroun,
en cassation de l'arrêt n° 12/CIV rendu le 15 janvier 2016 par la Cour d'appel du Littoral à Douala ;`;

export const FAITS = `Attendu, selon l'arrêt attaqué, que la Société Gamma SARL a assigné le sieur TCHOUPO Jean-Marie en paiement ;
que sa mère, Dame NGO BIYONG Esther, a attesté de sa minorité à la date des actes litigieux ;`;

export const MOYEN_1 = `Sur le premier moyen, tiré de la violation de l'article 7 de l'Acte uniforme portant sur le droit commercial général
Attendu qu'il est fait grief à l'arrêt d'avoir retenu que « TCHOUPO, émancipé par jugement du 3 mars 2014, exerçait le commerce de façon habituelle » ;
Mais attendu que M. le Président de la Cour d'appel a relevé que l'émancipation était antérieure aux actes litigieux ;
Qu'il échet de rejeter ce moyen ;`;

export const DISPOSITIF = `PAR CES MOTIFS :
Statuant publiquement, après en avoir délibéré,
Rejette le pourvoi formé par Monsieur TCHOUPO Jean-Marie ;
Le condamne aux dépens.`;

/** As a contributor would paste it. */
export const JUDGMENT_WITH_PERSONS = [
  CAPTION_WITH_PERSONS, PROCEDURE, FAITS, MOYEN_1, DISPOSITIF, 'Ainsi fait, jugé et prononcé les jour, mois et an que dessus.',
].join('\n');

/** What the leak test looks for in every published response: each word that could identify a person. */
export const PARTY_NAMES = ['TCHOUPO', 'Jean-Marie', 'NKOUM', 'Paul', 'NGO BIYONG', 'BIYONG', 'Esther'];

/**
 * A realistic LLM answer: each person once, with the full form only. The bare "TCHOUPO" of the quote is not listed:
 * it is found because the surname is derived from "TCHOUPO Jean-Marie".
 */
export const LLM_PERSONS: DetectedPersons = {
  persons: [
    { forms: ['TCHOUPO Jean-Marie'], role: 'party' },
    { forms: ['NKOUM Paul'], role: 'counsel' },
    { forms: ['NGO BIYONG Esther'], role: 'other' },
  ],
};
