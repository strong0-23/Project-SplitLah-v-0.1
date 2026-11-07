/**
 * Locale-aware money reading for OCR text. Pure.
 *
 * Handles "1,234.56", "1.234,56", "1 234,56", zero-decimal currencies ("¥1,200", "Rp 25.000"),
 * leading/trailing currency marks, negatives written as "-2.00", "2.00-", "(2.00)" or "2.00 CR",
 * and common OCR digit confusions inside numbers ("1O.5O" → "10.50"). A colon blocks an amount
 * only after a digit (times such as "19:47"), so "Total:4.00" is still read.
 *
 * Amounts are returned in the app's integer "cents" (major × 100 + minor), so a zero-decimal
 * amount such as ¥1,200 becomes 120000 and displays as 1,200.00. Splitting maths stays exact.
 */
import { MAX_CENTS } from "../money";

export interface NumberFormat {
  decimal: "." | ",";
  /** Digits after the decimal separator: 2 for most currencies, 0 for JPY/KRW/IDR/VND. */
  minorDigits: 0 | 2;
}

export interface CurrencyGuess {
  /** ISO 4217 code, or null when nothing on the receipt says. */
  code: string | null;
  minorDigits: 0 | 2;
}

export interface Amount {
  cents: number;
  negative: boolean;
  start: number;
  end: number;
}

export const DEFAULT_FORMAT: NumberFormat = { decimal: ".", minorDigits: 2 };

const SYMBOL = String.raw`(?:S\$|US\$|HK\$|A\$|NT\$|NZ\$|RM|Rp\.?|SGD|MYR|USD|EUR|GBP|JPY|IDR|THB|PHP|HKD|AUD|INR|KRW|VND|CNY|RMB|TWD|NZD|[$€£¥₩₫฿₱₹円元])`;

/** Code → [patterns that indicate it]. Order matters: more specific marks first. */
const CURRENCIES: Array<[string, RegExp, 0 | 2]> = [
  ["SGD", /\bS\$|\bSGD\b/, 2],
  ["MYR", /\bRM\s?\d|\bMYR\b|\bSST\b/, 2],
  ["IDR", /\bRp\.?\s?\d|\bIDR\b|\bPB1\b|\bPPN\b/, 0],
  ["USD", /\bUS\$|\bUSD\b/, 2],
  ["HKD", /\bHK\$|\bHKD\b/, 2],
  ["AUD", /\bA\$|\bAUD\b/, 2],
  ["TWD", /\bNT\$|\bTWD\b/, 2],
  ["NZD", /\bNZ\$|\bNZD\b/, 2],
  ["EUR", /€|\bEUR\b/, 2],
  ["GBP", /£|\bGBP\b/, 2],
  ["JPY", /[¥円]|\bJPY\b/, 0],
  ["KRW", /₩|\bKRW\b/, 0],
  ["VND", /₫|\bVND\b/, 0],
  ["THB", /฿|\bTHB\b/, 2],
  ["PHP", /₱|\bPHP\b/, 2],
  ["INR", /₹|\bINR\b/, 2],
  ["CNY", /\bCNY\b|\bRMB\b|元/, 2],
];

/** Picks the currency with the most marks on the receipt. A bare "$" says nothing. */
export function detectCurrency(lines: string[]): CurrencyGuess {
  const text = lines.join("\n");
  let best: { code: string; n: number; minor: 0 | 2 } | null = null;
  for (const [code, re, minor] of CURRENCIES) {
    const n = (text.match(new RegExp(re.source, "g")) ?? []).length;
    if (n > 0 && (!best || n > best.n)) best = { code, n, minor };
  }
  return best ? { code: best.code, minorDigits: best.minor } : { code: null, minorDigits: 2 };
}

/** Fixes letters OCR commonly puts inside numbers: O/o→0, l/I/|→1, only between digit-like chars. */
export function fixOcrDigits(line: string): string {
  let prev = "";
  let s = line;
  while (prev !== s) {
    prev = s;
    s = s
      .replace(/(?<=\d[.,]?)[Oo](?=[\d.,]|\s|$)|(?<!\p{L})[Oo](?=[.,]?\d)/gu, "0")
      .replace(/(?<=\d[.,])[lI|]|(?<=\d)[lI|](?=[.,]?\d)|(?<!\p{L})[lI|](?=[.,]?\d)/gu, "1");
  }
  return s;
}

/**
 * Chooses decimal separator and minor digits from the whole receipt: whichever of "x.yy" / "x,yy"
 * appears more often wins. Zero-decimal only when the currency says so and no 2-decimal prices exist.
 */
export function detectFormat(
  lines: string[],
  currency: CurrencyGuess = detectCurrency(lines),
): NumberFormat {
  let dot = 0,
    comma = 0,
    grouped = 0;
  for (const raw of lines) {
    const l = fixOcrDigits(raw);
    dot += (l.match(/(?<![\d.,])\d{1,7}(?:,\d{3})*\.\d{2}(?![.,]?\d)/g) ?? []).length;
    comma += (l.match(/(?<![\d.,])\d{1,7}(?:[.\s']\d{3})*,\d{2}(?![.,]?\d)/g) ?? []).length;
    grouped += (l.match(/(?<![\d.,])\d{1,3}(?:[.,]\d{3})+(?![.,]?\d)/g) ?? []).length;
  }
  if (currency.minorDigits === 0 && grouped >= Math.max(dot, comma)) {
    return {
      decimal: currency.code === "IDR" || currency.code === "VND" ? "," : ".",
      minorDigits: 0,
    };
  }
  return { decimal: comma > dot ? "," : ".", minorDigits: 2 };
}

function amountRegex(fmt: NumberFormat): RegExp {
  const group = fmt.decimal === "." ? "," : String.raw`[.\s']`;
  const sep = fmt.decimal === "." ? String.raw`\.` : ",";
  const number =
    fmt.minorDigits === 2
      ? String.raw`(\d{1,3}(?:${group}\d{3})+|\d{1,7})\s?${sep}\s?(\d{2})`
      : // Zero-decimal: a grouped number, or 3–6 plain digits (so a quantity "2" is never money).
        String.raw`(\d{1,3}(?:[.,]\d{3})+|\d{3,6})()`;
  return new RegExp(
    String.raw`(?<![\w.,/])(?<!\d\s?:)(\()?(-)?\s*${SYMBOL}?\s*(-)?${number}(?![.,]?\d)(?!\s?%)\s*${SYMBOL}?(\))?(\s*-(?!\s?\d)|\s*CR\b)?`,
    "gi",
  );
}

const toCents = (whole: string, frac: string, fmt: NumberFormat): number | null => {
  const w = Number(whole.replace(/[^\d]/g, ""));
  const c = fmt.minorDigits === 2 ? w * 100 + Number(frac) : w * 100;
  return Number.isSafeInteger(c) && c <= MAX_CENTS ? c : null;
};

/** All money amounts on a line, left to right. */
export function findAmounts(line: string, fmt: NumberFormat = DEFAULT_FORMAT): Amount[] {
  const out: Amount[] = [];
  const l = fixOcrDigits(line);
  for (const m of l.matchAll(amountRegex(fmt))) {
    const cents = toCents(m[4] ?? "", m[5] ?? "", fmt);
    if (cents === null) continue;
    const negative = Boolean(m[2] || m[3] || m[7] || (m[1] && m[6]));
    out.push({ cents, negative, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Parses a single amount string ("$7.80", "3,50 €", "Rp 25.000"). */
export function parseAmount(s: string, fmt: NumberFormat = DEFAULT_FORMAT): number | null {
  const a = findAmounts(s.trim(), fmt);
  return a.length === 1 ? a[0]!.cents : null;
}

/** "9%", "8.875 %", "19,0%" → basis points. */
export function findRateBp(label: string): number | null {
  const m = /(\d{1,2})(?:[.,](\d{1,3}))?\s*%/.exec(label);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, 2).padEnd(2, "0");
  const bp = Number(m[1]) * 100 + Number(frac);
  return bp > 0 && bp <= 10_000 ? bp : null;
}
