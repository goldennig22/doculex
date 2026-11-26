import { NoObjectGeneratedError } from 'ai';
import type { ExtractionOutput } from '../../src/services/decision-extraction.service';

// The layout of a CCJA judgment, with placeholders for the parties and numbers (not a real case).
// Four dates and three numbers, on purpose: only one of each belongs to THIS decision.

export const CAPTION = `COUR COMMUNE DE JUSTICE ET D'ARBITRAGE (CCJA)
Première chambre
Audience publique du 28 février 2019
Pourvoi n° 000/2016/PC du 10/05/2016
Affaire : Société Alpha SA (Conseil : Maître Beta)
contre
Société Gamma SARL
Arrêt N° 045/2019 du 28 février 2019
La Cour Commune de Justice et d'Arbitrage (CCJA), Première chambre, a rendu l'Arrêt suivant :`;

/** Chunks as ingestDecision stores them, deliberately out of order (the database returns them unordered). */
export const CHUNKS = [
  {
    articleRef: 'dispositif', part: 0,
    content: `PAR CES MOTIFS :
Statuant publiquement, après en avoir délibéré,
Rejette le pourvoi formé par la Société Alpha SA ;
La condamne aux dépens.`,
  },
  {
    articleRef: 'moyen-1', part: 0,
    content: `Sur le premier moyen, tiré de la violation de l'article 7 de l'Acte uniforme portant sur le droit commercial général
Attendu qu'il est fait grief à l'arrêt d'avoir retenu la qualité de commerçant d'un mineur non émancipé ;
Mais attendu que l'arrêt relève que le défendeur était émancipé à la date des actes litigieux ;
Qu'il échet de rejeter ce moyen ;`,
  },
  {
    articleRef: 'procedure', part: 0,
    content: `Sur le recours enregistré au greffe de la Cour le 10 mai 2016 sous le n° 000/2016/PC et formé par la Société Alpha SA,
en cassation de l'arrêt n° 12/CIV rendu le 15 janvier 2016 par la Cour d'appel du Littoral à Douala, dont le dispositif est le suivant :
PAR CES MOTIFS : Statuant publiquement, contradictoirement, en matière civile et commerciale, en appel et en dernier ressort ;
Confirme le jugement entrepris ;`,
  },
  {
    articleRef: 'faits', part: 0,
    content: `Attendu, selon l'arrêt attaqué, que la Société Alpha SA, se prévalant de la qualité de commerçant de son débiteur,
a assigné celui-ci en paiement devant le tribunal de première instance ;`,
  },
];

/** What a well-behaved model returns for this judgment. */
export const GOOD_OUTPUT: ExtractionOutput = {
  court: { value: 'CCJA', quote: "COUR COMMUNE DE JUSTICE ET D'ARBITRAGE (CCJA)" },
  country: { value: null, quote: null },
  chamber: { value: 'Première chambre', quote: 'Première chambre' },
  caseNumber: { value: 'Arrêt N° 045/2019', quote: 'Arrêt N° 045/2019' },
  decisionDate: { value: '2019-02-28', quote: 'Arrêt N° 045/2019 du 28 février 2019' },
  subject: {
    value: "Qualité de commerçant d'un mineur émancipé",
    quote: "le défendeur était émancipé à la date des actes litigieux",
  },
  outcome: { value: 'rejet', quote: 'Rejette le pourvoi' },
  headnote: "La Cour était saisie d'un pourvoi contestant la qualité de commerçant du défendeur. "
    + "Elle relève que le défendeur était émancipé à la date des actes litigieux. Elle rejette donc le pourvoi.",
};

/** What generateText throws when the model's output doesn't match the schema. A real instance, so isInstance holds. */
export const noObject = () => new NoObjectGeneratedError({
  message: 'No object generated: response did not match schema.',
  text: '{"court": "CCJA", "decisionDate": 28',
  response: { id: 'r1', timestamp: new Date(), modelId: 'test-primary' },
  usage: {
    inputTokens: 2400, outputTokens: 12, totalTokens: 2412,
    inputTokenDetails: { noCacheTokens: 2400, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 12, reasoningTokens: 0 },
  },
  finishReason: 'stop',
});
