import type { BasisPoints, Cents } from "./types";

export const MAX_CENTS = 999_999_999; // SGD 9,999,999.99
export const MAX_RATE_BP = 10_000; // 100%
export const MAX_QUANTITY = 9_999;

/** Parse a user/OCR decimal string into integer cents without floating point. null if invalid. */
export function parseMoney(input: string): Cents | null {
  if (typeof input !== "string") return null;
  const s = input.trim().replace(/^S?\$\s*/i, "").replace(/,/g, "");
  if (s === "") return null;
  const m = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(s) ?? /^()\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = (m[2] ?? "").padEnd(2, "0");
  const cents = whole * 100 + Number(frac || "0");
  return isSafeCents(cents) ? cents : null;
}

export function isSafeCents(v: unknown): v is Cents {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS;
}

/** Parse a percentage string like "9" or "8.25" into basis points. */
export function parseRate(input: string): BasisPoints | null {
  const s = input.trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bp <= MAX_RATE_BP ? bp : null;
}

export function formatRate(bp: BasisPoints): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? `${whole}` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export function centsToInput(c: Cents | null): string {
  if (c === null) return "";
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

export function formatMoney(c: Cents, currency = "SGD"): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100).toLocaleString("en-SG");
  return `${sign}${currency} ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Deterministic half-up rounding of amount * bp / 10000 using integers. */
export function applyRate(amount: Cents, bp: BasisPoints): Cents {
  const n = BigInt(amount) * BigInt(bp);
  return Number((n + 5000n) / 10000n);
}

/** GST contained in an inclusive gross: gross * bp / (10000 + bp), half-up. */
export function includedTax(gross: Cents, bp: BasisPoints): Cents {
  const d = BigInt(10000 + bp);
  return Number((BigInt(gross) * BigInt(bp) * 2n + d) / (2n * d));
}

export interface Weighted {
  id: string;
  weight: number;
}

/**
 * Largest-remainder allocation of `total` cents across weights.
 * Remainder cents go to the largest fractional parts; ties broken by ascending id.
 * Throws if total > 0 but all weights are zero, or on invalid inputs.
 */
export function allocateLargestRemainder(total: Cents, weights: Weighted[]): Record<string, Cents> {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Invalid total to allocate");
  const result: Record<string, Cents> = {};
  for (const w of weights) {
    if (!Number.isSafeInteger(w.weight) || w.weight < 0) throw new Error("Invalid weight");
    result[w.id] = 0;
  }
  if (total === 0) return result;
  const sum = weights.reduce((a, w) => a + BigInt(w.weight), 0n);
  if (sum === 0n) throw new Error("Cannot allocate a non-zero amount across zero weights");
  const T = BigInt(total);
  let given = 0n;
  const rems = weights.map((w) => {
    const p = T * BigInt(w.weight);
    const q = p / sum;
    given += q;
    result[w.id] = Number(q);
    return { id: w.id, rem: p % sum };
  });
  let left = Number(T - given);
  rems.sort((a, b) => (a.rem === b.rem ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  for (let i = 0; left > 0; i++, left--) {
    const r = rems[i];
    if (!r) break;
    result[r.id] = (result[r.id] ?? 0) + 1;
  }
  return result;
}
