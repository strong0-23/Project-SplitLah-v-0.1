/**
 * Finding the printed payable total from structure, not just labels. Pure.
 *
 * The parser collects every total-labelled line as a candidate; this module adds the evidence
 * that ranks them:
 * - Payment agreement: a card/cash payment line equal to a candidate (or cash tendered minus the
 *   change) is strong evidence that the candidate is what was paid. A payment, change, savings or
 *   points value is never itself taken as the total.
 * - Totals per section: when items were read between two different totals (one total per section)
 *   and the section totals add up to a payment amount, the payable total is their sum.
 * - Tax tables: rows of net + tax = gross under a rate/net/tax/gross heading give the tax amount.
 */

export interface TotalCandidate {
  cents: number;
  /** Label and amount on separate lines: weaker evidence. */
  split: boolean;
  /** Item rows read before this total (different values = different sections). */
  itemsBefore: number;
  /** `totalLabelStrength` of the label: 3 grand/payable, 2 total, 1 weaker. */
  strength: number;
}

export interface PaymentLine {
  cents: number;
  /** "Change 7.20": money given back, not paid. */
  change: boolean;
}

export type TotalPick =
  /** The candidate at `index` (into the pool passed in) equals what was paid. */
  | { kind: "payment"; index: number }
  /** Section totals that add up to what was paid. */
  | { kind: "sections"; cents: number; parts: number[] }
  | null;

/** Amounts the payment lines say were paid: each payment, their sum, and each minus the change. */
export function paidAmounts(payments: readonly PaymentLine[]): Set<number> {
  const paid = payments.filter((p) => !p.change).map((p) => p.cents);
  const change = payments.filter((p) => p.change).map((p) => p.cents);
  const out = new Set<number>(paid);
  if (paid.length > 1) out.add(paid.reduce((s, c) => s + c, 0));
  if (change.length === 1) {
    for (const p of [...out]) if (p - change[0]! > 0) out.add(p - change[0]!);
  }
  return out;
}

/**
 * Uses the payment lines to pick a total from `pool` (in printed order). Returns null when the
 * payments give no evidence, so the caller keeps its own position rule.
 */
export function findPaymentTotal(
  pool: readonly TotalCandidate[],
  payments: readonly PaymentLine[],
): TotalPick {
  if (!pool.length || !payments.length) return null;
  const paid = paidAmounts(payments);
  for (let k = pool.length - 1; k >= 0; k--)
    if (paid.has(pool[k]!.cents)) return { kind: "payment", index: k };
  // One total per section: the last total of each group of items, if items came in between.
  const bySection = new Map<number, number>();
  for (const t of pool) bySection.set(t.itemsBefore, t.cents);
  if (bySection.size < 2) return null;
  const parts = [...bySection.values()];
  const sum = parts.reduce((s, c) => s + c, 0);
  return paid.has(sum) ? { kind: "sections", cents: sum, parts } : null;
}

/** A tax-table row: the first three consecutive amounts with net + tax = gross (tax < net). */
export function readTaxTableRow(
  amounts: readonly number[],
): { net: number; tax: number; gross: number } | null {
  for (let k = 0; k + 2 < amounts.length; k++) {
    const [net, tax, gross] = [amounts[k]!, amounts[k + 1]!, amounts[k + 2]!];
    if (tax > 0 && tax < net && net + tax === gross) return { net, tax, gross };
  }
  return null;
}

/**
 * A last item row whose amount equals the sum of every item above it (at least two, all priced)
 * is a total with a damaged label ("Tl  14.60"), not an item. Only a row whose own label is weak
 * (`weakLabel`) qualifies. Returns its index, or -1.
 */
export function findSumRow(
  amounts: readonly (number | null)[],
  weakLabel: readonly boolean[],
): number {
  const k = amounts.length - 1;
  if (k < 2 || !weakLabel[k] || amounts[k] === null) return -1;
  let sum = 0;
  for (let j = 0; j < k; j++) {
    const a = amounts[j];
    if (a === null || a === undefined) return -1;
    sum += a;
  }
  return sum === amounts[k] ? k : -1;
}
