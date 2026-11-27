// The legal texts a court decision can cite, and how they are written. Data, not logic: the detector (detector.ts) and
// the grading (grading.ts) read it, and both stay pure because it lives in code, not in the database.
// Which document holds which act version is data and lives in the database (documents.act_code, act_version).

export const ACT_CODES = [
  'AUDCG', 'AUSCGIE', 'AUPSRVE', 'AUS', 'AUPC', 'AUA', 'TRAITE', 'RP_CCJA', 'CODE_CIVIL', 'NATIONAL_LAW',
] as const;
export type ActCode = (typeof ACT_CODES)[number];

/**
 * - uniform_act: what "du même Acte uniforme" can point back to.
 * - ohada: the Treaty and the CCJA's Rules of procedure; OHADA texts, but not Uniform Acts.
 * - national: never ingested, never linked (Code civil, a national statute). Known so they are neither sent to the LLM
 *   nor taken for the Act of the next bare "article 102" by mistake.
 */
export type ActKind = 'uniform_act' | 'ohada' | 'national';

export type ActVersion = {
  /** The adoption year, which is how decisions date an Act: "l'Acte uniforme du 17 avril 1997" */
  version: string;
  /** YYYY-MM-DD. Check against the Journal officiel de l'OHADA before relying on a date. */
  inForceFrom: string;
};

export type ActDefinition = {
  code: ActCode;
  kind: ActKind;
  /** What a reader sees, and what the LLM is shown next to the code */
  label: string;
  /** Upper case, matched as whole words; the original text must be in upper case too ("AUS", never "aus") */
  abbreviations: string[];
  /**
   * Phrases searched right after "Acte uniforme" / "Uniform Act", in folded form (lower case, no accents, straight
   * apostrophes: see foldForMatch). Keywords, not full titles: decisions shorten them ("relatif au droit des sociétés
   * commerciales", without the GIE). The earliest match wins, then the longest.
   */
  keywords: string[];
  /**
   * Standalone forms for acts that are not Uniform Acts ("Code civil", "Règlement de procédure de la CCJA"), as
   * folded regex sources. Longest alternative first.
   */
  patterns?: string[];
  /** Ascending. Empty: not linkable (never ingested, or no version ingested yet: add its versions when you do). */
  versions: ActVersion[];
};

export const ACTS: Record<ActCode, ActDefinition> = {
  AUDCG: {
    code: 'AUDCG', kind: 'uniform_act', label: 'Acte uniforme portant sur le droit commercial général',
    abbreviations: ['AUDCG'],
    keywords: ['portant sur le droit commercial general', 'relatif au droit commercial general', 'droit commercial general',
      'on general commercial law', 'relating to general commercial law', 'general commercial law'],
    versions: [{ version: '1997', inForceFrom: '1998-01-01' }, { version: '2010', inForceFrom: '2011-05-16' }],
  },
  AUSCGIE: {
    code: 'AUSCGIE', kind: 'uniform_act',
    label: "Acte uniforme relatif au droit des sociétés commerciales et du groupement d'intérêt économique",
    abbreviations: ['AUSCGIE', 'AUDSCGIE', 'AUSC'],
    keywords: [
      "relatif au droit des societes commerciales et du groupement d'interet economique",
      'relatif au droit des societes commerciales', 'droit des societes commerciales', 'societes commerciales',
      'relating to commercial companies and economic interest groups', 'relating to commercial companies',
      'on commercial companies', 'commercial companies',
    ],
    versions: [{ version: '1997', inForceFrom: '1998-01-01' }, { version: '2014', inForceFrom: '2014-05-05' }],
  },
  AUPSRVE: {
    code: 'AUPSRVE', kind: 'uniform_act',
    label: "Acte uniforme portant organisation des procédures simplifiées de recouvrement et des voies d'exécution",
    abbreviations: ['AUPSRVE', 'AUVE'],
    keywords: [
      "portant organisation des procedures simplifiees de recouvrement et des voies d'execution",
      "procedures simplifiees de recouvrement et des voies d'execution", 'procedures simplifiees de recouvrement',
      "voies d'execution", 'organising simplified recovery procedures and measures of execution',
      'simplified recovery procedures', 'measures of execution',
    ],
    versions: [{ version: '1998', inForceFrom: '1998-07-10' }],
  },
  AUS: {
    code: 'AUS', kind: 'uniform_act', label: 'Acte uniforme portant organisation des sûretés',
    abbreviations: ['AUS'],
    keywords: ['portant organisation des suretes', 'organisation des suretes', 'suretes',
      'organising securities', 'organisation of securities', 'on securities', 'securities'],
    versions: [{ version: '1997', inForceFrom: '1998-01-01' }, { version: '2010', inForceFrom: '2011-05-16' }],
  },
  AUPC: {
    code: 'AUPC', kind: 'uniform_act', label: "Acte uniforme portant organisation des procédures collectives d'apurement du passif",
    abbreviations: ['AUPC', 'AUPCAP'],
    keywords: ["procedures collectives d'apurement du passif", 'procedures collectives',
      'collective proceedings for wiping off debts', 'insolvency proceedings', 'collective proceedings'],
    versions: [{ version: '1998', inForceFrom: '1999-01-01' }, { version: '2015', inForceFrom: '2015-12-24' }],
  },
  AUA: {
    code: 'AUA', kind: 'uniform_act', label: "Acte uniforme relatif au droit de l'arbitrage",
    abbreviations: ['AUA'],
    keywords: ["relatif au droit de l'arbitrage", "droit de l'arbitrage", 'on arbitration law', 'arbitration law', 'arbitration'],
    versions: [{ version: '1999', inForceFrom: '1999-06-11' }, { version: '2017', inForceFrom: '2018-03-15' }],
  },
  TRAITE: {
    code: 'TRAITE', kind: 'ohada', label: "Traité relatif à l'harmonisation du droit des affaires en Afrique",
    abbreviations: [],
    keywords: [],
    patterns: [
      "traite relatif a l'harmonisation du droit des affaires en afrique", 'traite (?:de l\')?ohada', 'traite',
      'treaty on the harmonisation of business law in africa', 'ohada treaty', 'treaty',
    ],
    versions: [],
  },
  RP_CCJA: {
    code: 'RP_CCJA', kind: 'ohada', label: "Règlement de procédure de la Cour Commune de Justice et d'Arbitrage",
    abbreviations: [],
    keywords: [],
    patterns: [
      "reglement de procedure de la cour commune de justice et d'arbitrage", 'reglement de procedure de la ccja',
      'reglement de procedure', 'rules of procedure of the common court of justice and arbitration',
      'rules of procedure of the ccja', 'rules of procedure',
    ],
    versions: [],
  },
  CODE_CIVIL: {
    code: 'CODE_CIVIL', kind: 'national', label: 'Code civil',
    abbreviations: [],
    keywords: [],
    patterns: ['code civil', 'civil code'],
    versions: [],
  },
  NATIONAL_LAW: {
    code: 'NATIONAL_LAW', kind: 'national', label: 'Texte national (loi, décret, ordonnance, code national)',
    abbreviations: [],
    keywords: [],
    patterns: [
      'code de procedure civile(?: et commerciale)?', 'code de procedure penale', 'code penal', 'code du travail',
      'code general des impots', 'code de commerce', 'code des obligations civiles et commerciales',
      'loi n\\s*[°o]?', 'loi du', 'decret n\\s*[°o]?', 'ordonnance n\\s*[°o]?', 'law no\\.?',
    ],
    versions: [],
  },
};

/** Acts a document can hold (documents.act_code): those with at least one version. */
export const LINKABLE_ACT_CODES = ACT_CODES.filter((c) => ACTS[c].versions.length > 0) as [ActCode, ...ActCode[]];

export const isLinkable = (code: ActCode): boolean => ACTS[code].versions.length > 0;
