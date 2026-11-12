/**
 * Total-anchored item selection. Pure: no DOM, no SDK, no parser state.
 *
 * Idea: a receipt's item lines must add up to its printed total (plus or minus the printed charges
 * and bill discount). When OCR turns header, address, card or footer lines into extra "items", the
 * printed total tells us which lines are the real items: the subset of candidate lines whose sum
 * hits the target exactly.
 *
 * Safety rules (a wrong choice here would hide a real item while the bill "matches"):
 * - Protected rows (unflagged rows inside the item section) are never set aside; only flagged rows
 *   and rows outside the item section can be. Most real items are protected, so the search is over
 *   a handful of doubtful rows, which keeps chance coincidences rare.
 * - The best subset must be unique. Ranking: keep more rows inside the item section, then keep more
 *   rows. If two different subsets rank equally, or more than one tax reading (GST added vs
 *   included) has an exact subset, nothing is set aside (`ambiguous`).
 * - Nothing is deleted: set-aside rows are returned so the review screen can show and restore them.
 * - The search is bounded by size, not time, so the same text always gives the same answer:
 *   at most `MAX_CANDIDATES` doubtful rows and `MAX_CELLS` DP cells.
 */

/** One candidate item line, in printed order. */
export interface AnchorRow {
  /** Line total in cents for the full quantity, net of item discounts; null = no price read. */
  cents: number | null;
  /** Printed inside the item section (after the header lines, before the summary). */
  inside: boolean;
  /** Never set aside: an unflagged, priced row inside the item section. */
  protected: boolean;
}

export interface AnchorInput {
  rows: readonly AnchorRow[];
  /** Printed payable total (before cash rounding, D4). Required. */
  totalCents: number;
  /** Bill-level discount (item discounts are already in the rows). */
  discountCents: number;
  /** Printed service charge and fees (D6); 0 when none. */
  serviceCents: number;
  /** Printed tax amount, or null when none was read. */
  taxCents: number | null;
  /** true: tax known to be included in prices; false: known to be added; null: unknown. */
  inclusive: boolean | null;
}

export type AnchorOutcome =
  /** Exactly one best subset: `setAside` lists row indexes (priced and unpriced) not in it. */
  | { status: "matched"; setAside: number[]; inclusive: boolean | null }
  /** Several equally good subsets or tax readings: nothing is set aside. */
  | { status: "ambiguous" }
  /** No subset of the doubtful rows reaches the target. */
  | { status: "no-match" }
  /** Too many doubtful rows or too large a target for the bounded search. */
  | { status: "too-large" };

/** Doubtful rows searched at most (the brief's cap of about 40). */
export const MAX_CANDIDATES = 40;
/** DP table size limit (rows × target cents): about 4 MB, deterministic. */
export const MAX_CELLS = 4_000_000;

interface Best {
  /** Kept-row indexes into the doubtful list, or null when no subset hits the target. */
  keep: number[] | null;
  /** Number of distinct subsets with the best rank (capped at 2). */
  ways: number;
}

/**
 * Best subset of `amounts` summing to exactly `need`. Rank: more `inside` rows, then more rows.
 * 0/1 knapsack over cents with a rank and a capped count of ways per sum; choice bits allow
 * rebuilding the subset when it is unique.
 */
function bestSubset(amounts: readonly number[], inside: readonly boolean[], need: number): Best {
  const n = amounts.length;
  if (need === 0) return { keep: [], ways: 1 };
  if (need < 0 || n === 0) return { keep: null, ways: 0 };
  const rank = new Int32Array(need + 1).fill(-1); // -1 = unreachable
  const ways = new Uint8Array(need + 1);
  const took = new Uint8Array(n * (need + 1));
  rank[0] = 0;
  ways[0] = 1;
  for (let i = 0; i < n; i++) {
    const a = amounts[i]!;
    const w = (inside[i] ? 64 : 0) + 1; // n ≤ 40 < 64, so "inside" always outranks count
    for (let s = need; s >= a; s--) {
      const from = rank[s - a]!;
      if (from < 0) continue;
      const cand = from + w;
      if (cand > rank[s]!) {
        rank[s] = cand;
        ways[s] = ways[s - a]!;
        took[i * (need + 1) + s] = 1;
      } else if (cand === rank[s]!) {
        ways[s] = Math.min(2, ways[s]! + ways[s - a]!);
        took[i * (need + 1) + s] = 0; // tie: ways ≥ 2, the subset is never rebuilt
      }
    }
  }
  if (rank[need]! < 0) return { keep: null, ways: 0 };
  if (ways[need]! > 1) return { keep: null, ways: 2 };
  const keep: number[] = [];
  let s = need;
  for (let i = n - 1; i >= 0 && s > 0; i--) {
    if (took[i * (need + 1) + s]) {
      keep.push(i);
      s -= amounts[i]!;
    }
  }
  return { keep: keep.reverse(), ways: 1 };
}

/** The target item sums for each tax reading the printed numbers allow. */
function targets(inp: AnchorInput): Array<{ cents: number; inclusive: boolean | null }> {
  const base = inp.totalCents - inp.serviceCents + inp.discountCents;
  const tax = inp.taxCents ?? 0;
  if (tax === 0) return [{ cents: base, inclusive: null }];
  if (inp.inclusive === true) return [{ cents: base, inclusive: true }];
  if (inp.inclusive === false) return [{ cents: base - tax, inclusive: false }];
  return [
    { cents: base - tax, inclusive: false },
    { cents: base, inclusive: true },
  ];
}

export function anchorItems(inp: AnchorInput): AnchorOutcome {
  const fixedSum = inp.rows.reduce(
    (s, r) => s + (r.protected && r.cents !== null ? r.cents : 0),
    0,
  );
  const doubtful: number[] = []; // row indexes that may be kept or set aside
  inp.rows.forEach((r, i) => {
    if (!r.protected && r.cents !== null && r.cents > 0) doubtful.push(i);
  });
  // A row with a zero or negative amount, or a protected one, is always kept.
  const lockedOther = inp.rows.reduce(
    (s, r) => s + (!r.protected && r.cents !== null && r.cents <= 0 ? r.cents : 0),
    0,
  );
  if (doubtful.length > MAX_CANDIDATES) return { status: "too-large" };
  const amounts = doubtful.map((i) => inp.rows[i]!.cents!);
  const inside = doubtful.map((i) => inp.rows[i]!.inside);
  const doubtfulSum = amounts.reduce((s, a) => s + a, 0);

  const found: Array<{ keep: number[]; inclusive: boolean | null }> = [];
  let ambiguous = false;
  let tooLarge = false;
  for (const t of targets(inp)) {
    const need = t.cents - fixedSum - lockedOther;
    if (need < 0 || need > doubtfulSum) continue;
    if (doubtful.length * (need + 1) > MAX_CELLS) {
      tooLarge = true;
      continue;
    }
    const best = bestSubset(amounts, inside, need);
    if (best.ways > 1) ambiguous = true;
    else if (best.keep) found.push({ keep: best.keep, inclusive: t.inclusive });
  }
  if (ambiguous || found.length > 1) return { status: "ambiguous" };
  if (!found.length) return { status: tooLarge ? "too-large" : "no-match" };
  const kept = new Set(found[0]!.keep.map((k) => doubtful[k]!));
  const setAside: number[] = [];
  inp.rows.forEach((r, i) => {
    if (r.protected || (r.cents !== null && r.cents <= 0)) return;
    if (r.cents === null || !kept.has(i)) setAside.push(i);
  });
  return { status: "matched", setAside, inclusive: found[0]!.inclusive };
}
