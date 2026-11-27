import { createHmac } from 'node:crypto';
import { env } from '../../config/env';

// Names as data: normalising, hashing, and finding a hashed name again. Pure (the key is a parameter with a default).

/**
 * The comparison form of a name or of any text: accents removed, lower case, and every run of characters that is
 * neither a letter nor a digit becomes one space. "TCHOUPO Jean-Marie", "Tchoupo  JEAN MARIE" and
 * "tchoupo, jean-marie" all give "tchoupo jean marie". Applied to both sides of every comparison.
 */
export function normaliseName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** HMAC of an already normalised name. findLeaks calls it for every word sequence of a decision, so no re-normalising. */
function hmacNormalised(decisionId: string, normalised: string, key: string): string {
  return createHmac('sha256', key).update(`${decisionId}\0${normalised}`).digest('hex');
}

/**
 * name_mentions.original_hash. Not plain SHA-256, unlike API keys: a key is 256 random bits, a name is not, and hashing
 * every surname of a list reverses an unkeyed hash in seconds. The key lives outside the database (env), and the
 * decision id is in the message, so the same person gets unrelated hashes in two decisions: nobody can link them.
 */
export function nameHash(decisionId: string, surface: string, key: string = env.ANONYMISATION_HMAC_KEY): string {
  return hmacNormalised(decisionId, normaliseName(surface), key);
}

/** Longest name the leak check looks for, in words: "NGO BIYONG Esther épouse TCHOUPO" is 5. */
export const MAX_NAME_WORDS = 6;

/**
 * Publish-time check: which fields still contain a name whose hash is in `hashes` (every mention of the decision).
 * Every sequence of 1 to maxWords words of each field is normalised, hashed and looked up, so a name is found again
 * without ever being stored in clear: the headnote the extraction LLM wrote with "le sieur TCHOUPO" in it fails here.
 * Returns the names of the failing fields, never the names found.
 */
export function findLeaks(
  fields: { field: string; text: string | null }[],
  hashes: ReadonlySet<string>,
  decisionId: string,
  { key = env.ANONYMISATION_HMAC_KEY, maxWords = MAX_NAME_WORDS }: { key?: string; maxWords?: number } = {},
): string[] {
  if (hashes.size === 0) return [];
  const leaking: string[] = [];
  for (const { field, text } of fields) {
    if (!text) continue;
    const words = normaliseName(text).split(' ').filter(Boolean);
    let found = false;
    for (let i = 0; i < words.length && !found; i++) {
      for (let n = 1; n <= maxWords && i + n <= words.length; n++) {
        if (hashes.has(hmacNormalised(decisionId, words.slice(i, i + n).join(' '), key))) { found = true; break; }
      }
    }
    if (found) leaking.push(field);
  }
  return leaking;
}

// An upper-case word of 2+ letters: "TCHOUPO", "NGO", "N'DIAYE", "ESSOMBA-ATANGANA". Not "M." or "X".
const UPPER_WORD = /^\p{Lu}[\p{Lu}\p{M}'’-]*\p{Lu}$/u;

/**
 * The other ways a name is written in the same decision. By convention the upper-case part is the surname, and a
 * judgment that wrote "TCHOUPO Jean-Marie" once writes "TCHOUPO" alone later (often inside a quote). Each maximal run
 * of upper-case words is a form, taken whole: "NGO BIYONG Esther" gives "NGO BIYONG", never "NGO" alone, which is also
 * a common word in the grounds (une NGO). First names alone are never derived: too common, too ambiguous.
 */
export function deriveForms(surface: string): string[] {
  const words = surface.trim().split(/\s+/);
  const forms = new Set([surface.trim()]);
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) forms.add(run.join(' '));
    run = [];
  };
  for (const w of words) {
    if (UPPER_WORD.test(w)) run.push(w);
    else flush();
  }
  flush();
  return [...forms];
}
