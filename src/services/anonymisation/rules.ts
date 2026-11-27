import { normaliseName } from './names';
import type { Candidate, Segment } from './mentions';

// Pass 1 of detection: a title or marker, then the capitalised words that follow it. Deterministic and free, and
// precise on titled names; blind to a bare name ("« TCHOUPO, émancipé… »"), which is what the LLM pass is for.
// It finds the NAME only: the title stays in the text ("Monsieur TCHOUPO Jean-Marie" → "Monsieur X").

// Longest first where one is a prefix of another (MM. before M., Mmes before Mme, Mrs before Mr).
const TITLES = [
  'Monsieur', 'Messieurs', 'Madame', 'Mesdames', 'Mademoiselle', 'Maître', 'Maitre', 'Docteur',
  '[Ss]ieur', '[Dd]ame', '[Ll]e\\s+nommé', '[Ll]a\\s+nommée', '[Ll]es\\s+nommés', '[Vv]euve', 'Vve', 'épouse', 'née', 'feu',
  'MM\\.', 'M\\.', 'Mmes', 'Mme', 'Mlles', 'Mlle', 'Me', 'Dr\\.?',
  'Mrs\\.?', 'Mr\\.?', 'Ms\\.?', 'Miss',
  // A sole proprietorship (entreprise individuelle) has no legal personality of its own: "Établissements KAMGA" names
  // the trader. Skipped when a company form follows (SA, SARL…): that one is a company, and companies stay named.
  'Ets\\.?', '[EÉ]tablissements',
];
const TITLE_SOURCE = `(?:${TITLES.join('|')})`;
const SOLE_TRADER = /^(?:Ets\.?|[EÉ]tablissements)$/u;

/** Not preceded by a letter, digit or dot ("N.M." is not "M."), followed by whitespace. */
const TITLE = new RegExp(`(?<![\\p{L}\\p{N}.])(${TITLE_SOURCE})\\s+`, 'gu');
const LEADING_TITLE = new RegExp(`^(?:(?:le|la|les|du|des)\\s+)?${TITLE_SOURCE}\\s+`, 'iu');

// A name word starts with a capital: "TCHOUPO", "Jean-Marie", "N'DIAYE". Words are separated by spaces or one line break.
const NAME_WORD = /\p{Lu}[\p{L}\p{M}'’-]*/uy;
const GAP = /[ \t\u00A0]+|[ \t\u00A0]*\n[ \t\u00A0]*/y;
const MAX_WORDS = 6;

// Capitalised words that end a name, or mean the title introduces a function, not a person:
// "M. FOTSO Directeur Général", "Mr Justice …", "Monsieur Le Président", "Maître NKOUM, Avocat".
const STOP_WORDS = new Set([
  'president', 'presidente', 'procureur', 'avocat', 'avocate', 'avocats', 'notaire', 'huissier', 'greffier', 'greffiere',
  'juge', 'juges', 'conseiller', 'conseillere', 'directeur', 'directrice', 'general', 'generale', 'gerant', 'gerante',
  'administrateur', 'liquidateur', 'syndic', 'expert', 'ministre', 'maire', 'prefet', 'commissaire', 'societe', 'cabinet',
  'barreau', 'cour', 'tribunal', 'etat', 'republique',
  'justice', 'judge', 'registrar', 'counsel', 'attorney', 'director', 'manager', 'court', 'state', 'republic',
  'le', 'la', 'les', 'l', 'de', 'du', 'des', 'et', 'the', 'of', 'and',
  'sa', 'sarl', 'sas', 'sasu', 'snc', 'scs', 'gie', 'fils', 'ets', 'etablissements',
]);
const COMPANY_FORM = /(?<!\p{L})(?:SARL|SASU|SAS|SA|SNC|SCS|GIE|S\.A\.R\.L\.|S\.A\.S\.|S\.A\.)(?!\p{L})/u;
// "Monsieur ETOA Martin, Président" in the composition of the court: a judge sitting in the case keeps their name.
// Not counsel: "Maître NKOUM Paul, Avocat" is anonymised (lawyers are not public officers of the court here).
const JUDICIAL_FUNCTION = /^[ \t]*,?[ \t]*(?:Premier[ \t]+)?(?:Président|Présidente|Vice-Président|Juge|Conseiller|Conseillère|Greffier|Greffière|Greffier[ \t]+en[ \t]+chef|Avocat[ \t]+Général|Procureur|Rapporteur|President|Judge|Registrar|Justice)(?![\p{L}])/iu;

/** The capitalised words right after `from`: [start, end) of the name, or null when there is none. */
function nameAfter(text: string, from: number): { start: number; end: number } | null {
  let pos = from;
  let end = -1;
  for (let words = 0; words < MAX_WORDS; words++) {
    if (words > 0) {
      GAP.lastIndex = pos;
      if (!GAP.exec(text)) break;
      pos = GAP.lastIndex;
    }
    NAME_WORD.lastIndex = pos;
    const m = NAME_WORD.exec(text);
    if (!m) break;
    const word = m[0].replace(/['’-]+$/u, ''); // a hyphen left at a line end: "TCHOUPO-"
    if (STOP_WORDS.has(normaliseName(word))) break;
    end = pos + word.length;
    pos = NAME_WORD.lastIndex;
  }
  return end === -1 ? null : { start: from, end };
}

export function detectByRules(seg: Segment): Candidate[] {
  const found: Candidate[] = [];
  for (const m of seg.text.matchAll(TITLE)) {
    const span = nameAfter(seg.text, m.index + m[0].length);
    if (!span) continue;
    if (SOLE_TRADER.test(m[1])) {
      const restOfLine = seg.text.slice(span.start).split('\n', 1)[0].slice(0, 80);
      if (COMPANY_FORM.test(restOfLine)) continue;
    }
    if (JUDICIAL_FUNCTION.test(seg.text.slice(span.end, span.end + 40))) continue;
    found.push({ segmentId: seg.id, ...span, surface: seg.text.slice(span.start, span.end), source: 'rule' });
  }
  return found;
}

/** "M. TCHOUPO" → "TCHOUPO": the LLM is told to leave titles out, and sometimes doesn't. */
export const stripTitle = (form: string): string => form.trim().replace(LEADING_TITLE, '').trim();
