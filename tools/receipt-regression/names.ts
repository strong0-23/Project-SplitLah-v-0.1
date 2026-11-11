/**
 * Item-name matching for scoring (pure; no DOM, no OCR, no dependencies).
 *
 * Two named modes:
 * - `exact`: the harness's original rule, unchanged. Names match after trimming, collapsing
 *   whitespace and lower-casing, or the reference name followed by a note the app added in
 *   brackets ("DRY MEE POK (MEMBER DISC -1.00)"). Each reference item takes the first unused app
 *   item, in printed order. Used by the Batch 1b parser gate (parser-v2 vs rework); its definition
 *   must not change.
 * - `recognisable` (owner decision, 11 Nov 2026, made before any held-out run): used by the Phase 2c
 *   engine comparison. A name OCR misspelled but still clearly the same item counts as matched.
 *   Exact pairs (by the `exact` rule) are made first. The remaining items are then paired greedily
 *   by descending similarity (ties: reference printed order, then app printed order), only at a
 *   similarity of `RECOGNISABLE_THRESHOLD` or more, and always one-to-one. An unrecognisable name
 *   stays missing + extra.
 *
 * Similarity is the normalised Levenshtein ratio, 1 − distance / max(length), on names normalised
 * by `normaliseName`. A leading item-code token (`M5`, `A12`) is ignored when only one of the two
 * names has one: menus print codes that the reference or the OCR reading often leaves out, and the
 * code alone would otherwise sink short names ("A12 Tea" vs "Tea": 0.43 with the code, 1.0 without).
 * When both names carry a code it is kept, so "A1 Tea" and "A2 Tea" stay distinct by one edit.
 */

export type NameMatch = "exact" | "recognisable";

/** Minimum similarity for a recognisable (inexact) name match. */
export const RECOGNISABLE_THRESHOLD = 0.7;

/** The rule each scoring path uses. The 1b gate's rule is fixed; the engine comparison's is new. */
export const PARSER_GATE_NAME_MATCH: NameMatch = "exact";
export const ENGINE_COMPARISON_NAME_MATCH: NameMatch = "recognisable";

/** The label written into summaries, so a pasted summary shows which rule was used. */
export function nameMatchLabel(mode: NameMatch): string {
  return mode === "exact" ? "exact" : `recognisable-${RECOGNISABLE_THRESHOLD.toFixed(2)}`;
}

/** The harness's original exact-rule normalisation (unchanged). */
export const exactNorm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");

/** A leading quantity token: "1 ", "2x ", "2 x ", "3× ". */
const LEADING_QTY = /^\d{1,2}\s*[x×]?\s+(?=\S)/u;
/** A leading item-code token: one or two letters then digits, e.g. "m5 ", "a12 ", "b12a ". */
const LEADING_CODE = /^[a-z]{1,2}\d{1,3}[a-z]?\s+(?=\S)/u;

/**
 * Case-fold, NFKC, strip punctuation except `&` (apostrophes vanish, other marks become spaces),
 * collapse whitespace, and drop one leading quantity token.
 */
export function normaliseName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’`]/gu, "")
    .replace(/[^\p{L}\p{N}\s&×]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(LEADING_QTY, "")
    .replace(/×/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Levenshtein distance over code points (insert, delete, substitute; each costs 1). */
export function levenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    for (let j = 1; j <= y.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[y.length]!;
}

/** 1 − distance / max(length), on strings already normalised. Two empty strings give 0. */
export function ratio(a: string, b: string): number {
  const n = Math.max(Array.from(a).length, Array.from(b).length);
  return n === 0 ? 0 : 1 - levenshtein(a, b) / n;
}

/** Drops a leading item code from whichever side has one, when the other side lacks it. */
function withoutLoneCode(a: string, b: string): [string, string] {
  const ca = LEADING_CODE.test(a);
  const cb = LEADING_CODE.test(b);
  if (ca === cb) return [a, b];
  return [a.replace(LEADING_CODE, ""), b.replace(LEADING_CODE, "")];
}

/**
 * Similarity of a reference name and an app name. The app may have added a note in brackets after
 * the name (D2/D3); the better of "with" and "without that note" counts.
 */
export function nameSimilarity(expected: string, actual: string): number {
  const forms = [actual];
  const note = /^(.*\S)\s*\([^()]*\)\s*$/u.exec(actual);
  if (note) forms.push(note[1]!);
  let best = 0;
  for (const form of forms) {
    const [a, b] = withoutLoneCode(normaliseName(expected), normaliseName(form));
    best = Math.max(best, ratio(a, b));
  }
  return best;
}

/**
 * Pairs reference items with app items, one-to-one. Returns, per reference item (in order), the
 * index of its app item, or undefined when it is missing.
 */
export function pairNames(
  expected: readonly string[],
  actual: readonly string[],
  mode: NameMatch,
): Array<number | undefined> {
  const unused = new Set(actual.map((_, i) => i));
  const out: Array<number | undefined> = [];
  // Stage 1, and all of `exact` mode: the original rule, unchanged.
  for (const description of expected) {
    const name = exactNorm(description);
    const free = [...unused];
    const index =
      free.find((i) => exactNorm(actual[i]!) === name) ??
      free.find((i) => exactNorm(actual[i]!).startsWith(`${name} (`));
    if (index !== undefined) unused.delete(index);
    out.push(index);
  }
  if (mode === "exact") return out;
  // Stage 2: recognisable names, greedy by similarity, ties by printed order, one-to-one.
  const candidates: Array<{ e: number; a: number; s: number }> = [];
  out.forEach((index, e) => {
    if (index !== undefined) return;
    for (const a of unused) {
      const s = nameSimilarity(expected[e]!, actual[a]!);
      if (s >= RECOGNISABLE_THRESHOLD) candidates.push({ e, a, s });
    }
  });
  candidates.sort((p, q) => q.s - p.s || p.e - q.e || p.a - q.a);
  for (const { e, a } of candidates) {
    if (out[e] !== undefined || !unused.has(a)) continue;
    out[e] = a;
    unused.delete(a);
  }
  return out;
}
