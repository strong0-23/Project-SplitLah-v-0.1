/**
 * Reading coverage (WO-001): how much of a receipt's printed money reached the parser. Pure.
 *
 * The reference lists the amounts printed on the paper: each product's full line amount, each
 * charge (service, fees, GST lines), the GST amount when no charge row already holds it, and the
 * printed payable total. Coverage is the share of those amounts that appear anywhere in the OCR
 * text, as a multiset: an amount printed three times on the paper needs three readings of it.
 *
 * An amount "appears" when the text holds the same digits as a two-decimal number: `12.90`,
 * `12,90`, `1,234.56`, `$12.90`, `-1.00`, `1.00-`. A misread digit or a letter inside the number
 * (`1O.50`) does not count: coverage measures what the recogniser delivered, not what the parser
 * can repair. The result is a count (found / of), never the amounts themselves.
 */

type Key =
  | "products"
  | "row_kind"
  | "full_line_amount"
  | "charges"
  | "kind"
  | "printed_amount"
  | "gst"
  | "printed_payable_total";
type Json = { [K in Key]?: unknown };
type Field = { state?: unknown; value?: unknown; value_cents?: unknown } | undefined | null;

const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const knownCents = (f: Field): number | undefined =>
  !!f && typeof f === "object" && f.state === "known" && Number.isSafeInteger(f.value_cents)
    ? Math.abs(f.value_cents as number)
    : undefined;
const knownValue = (f: Field): unknown =>
  !!f && typeof f === "object" && f.state === "known" ? f.value : undefined;

/**
 * The printed amounts a reading should contain, in cents (absolute values, zero amounts left out).
 * Known fields only; anything not known is simply not counted.
 */
export function printedAmounts(reference: unknown): number[] {
  const ref = obj(reference);
  const out: number[] = [];
  const add = (c: number | undefined) => {
    if (c !== undefined && c > 0) out.push(c);
  };
  for (const p of arr(ref.products)) {
    if (knownValue(p.row_kind as Field) === "return") continue;
    add(knownCents(p.full_line_amount as Field));
  }
  let taxCharge = false;
  for (const c of arr(ref.charges)) {
    const kind = knownValue(c.kind as Field);
    if (typeof kind === "string" && /gst|tax|vat/i.test(kind)) taxCharge = true;
    add(knownCents(c.printed_amount as Field));
  }
  if (!taxCharge) add(knownCents(obj(ref.gst).printed_amount as Field));
  add(knownCents(ref.printed_payable_total as Field));
  return out;
}

/** Two-decimal numbers in OCR text, in cents. Thousands separators are allowed before the decimals. */
export function amountsInText(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)[.,](\d{2})(?![.,]?\d)/g;
  for (const m of text.matchAll(re)) {
    const whole = Number(m[1]!.replace(/[.,]/g, ""));
    if (Number.isSafeInteger(whole)) out.push(whole * 100 + Number(m[2]));
  }
  return out;
}

export interface Coverage {
  found: number;
  of: number;
}

/** How many of `amounts` appear in `text` (multiset: each reading is used once). */
export function readingCoverage(amounts: readonly number[], text: string): Coverage {
  const pool = new Map<number, number>();
  for (const a of amountsInText(text)) pool.set(a, (pool.get(a) ?? 0) + 1);
  let found = 0;
  for (const a of amounts) {
    const left = pool.get(a) ?? 0;
    if (left > 0) {
      found++;
      pool.set(a, left - 1);
    }
  }
  return { found, of: amounts.length };
}

/** Coverage as a share 0..1; null when the reference has no known amounts. */
export const coverageShare = (c: Coverage | null | undefined): number | null =>
  c && c.of > 0 ? c.found / c.of : null;
