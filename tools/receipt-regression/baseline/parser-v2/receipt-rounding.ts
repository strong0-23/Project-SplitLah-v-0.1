import { isSafeSignedCents, parseMoney } from "./money";
import type { FieldEvidence, Receipt, ReceiptRowEvidence, SourceEvidence } from "./types";

/** Deliberately finite labels: a product merely containing "round" is not rounding. */
const ROUNDING_LABEL = /^(?:(?:cash|bill|final)\s+rounding(?:\s+(?:adjustment|adj))?|rounding(?:\s+(?:adjustment|adj))?|round\s*(?:off|adj(?:ustment)?))(?=$|[\s:=])/i;
const FINAL_TOTAL = /^(?:grand\s+total|total(?:\s+(?:amount|amt|due|payable))?|amount\s+(?:due|payable)|nett?\s+(?:total|amount)|balance\s+due)\s*[:=]?\s*(?:SGD\s*|S?\$\s*)?\d+[.,]\d{2}\s*$/i;
const SUMMARY = /^(?:sub\s*-?\s*total|sales\s+amount|net\s+sales|service(?:\s+charge)?|svc\s+chg|gst|vat|tax|grand\s+total|total)\b/i;

function roundingPayload(line: string): string | null {
  const trimmed = line.trim();
  const label = ROUNDING_LABEL.exec(trimmed);
  if (!label) return null;
  const payload = trimmed.slice(label[0].length).replace(/^\s*[:=]\s*/, "").trim();
  // An explicit cash/bill/final label remains inspectable even with unreadable
  // content. A bare "Rounding biscuits" remains a possible product instead.
  if (!/^(?:cash|bill|final)\b/i.test(label[0]) && /[A-Za-z]/.test(payload.replace(/SGD|S\$/gi, "")) && !/^(?:unreadable|illegible|unknown)$/i.test(payload)) return null;
  return payload;
}

/** Used by the parser before payment/product handling; it makes no amount decision. */
export function isReceiptRoundingLine(line: string): boolean {
  return roundingPayload(line) !== null;
}

function readableAmount(payload: string): { cents: number | null; signKnown: boolean } {
  let value = payload.trim().replace(/^SGD\s*/i, "").replace(/^S?\$\s*/, "");
  const prefix = /^([+-])\s*(?:SGD\s*|S?\$\s*)?(\d{1,7}(?:,\d{3})*\.\d{2})$/i.exec(value);
  const suffix = /^(\d{1,7}(?:,\d{3})*\.\d{2})\s*([+-])$/.exec(value);
  const parenthesised = /^\(\s*(?:SGD\s*|S?\$\s*)?(\d{1,7}(?:,\d{3})*\.\d{2})\s*\)$/i.exec(value);
  const unsigned = /^(\d{1,7}(?:,\d{3})*\.\d{2})$/.exec(value);
  const raw = prefix?.[2] ?? suffix?.[1] ?? parenthesised?.[1] ?? unsigned?.[1];
  const magnitude = raw === undefined ? null : parseMoney(raw);
  if (magnitude === null) return { cents: null, signKnown: false };
  const sign = prefix?.[1] ?? suffix?.[2] ?? (parenthesised ? "-" : null);
  return { cents: sign === "-" ? -magnitude : magnitude, signKnown: sign !== null || magnitude === 0 };
}

/**
 * Extract an independently labelled final bill adjustment, never a balancing
 * difference. A repeated row is retained as an ambiguity, not summed/deduped.
 * Call after product extraction and before charge reconciliation. No input is
 * mutated and no parser/engine confidence score is consulted.
 */
export function applyReceiptRounding(receipt: Receipt, text: string): Receipt {
  const lines = text.split(/\r?\n/);
  const candidates = lines.flatMap((line, index) => {
    const payload = roundingPayload(line);
    return payload === null ? [] : [{ line, index, ...readableAmount(payload) }];
  });
  if (candidates.length === 0) return receipt;

  const productIndices = receipt.items.flatMap((item) => (item.evidence?.description?.sources ?? [])
    .flatMap((source) => source.lineIndices ?? []));
  const lastProduct = productIndices.length ? Math.max(...productIndices) : -1;
  const candidate = candidates.length === 1 ? candidates[0]! : null;
  const reasons: string[] = [];
  if (!candidate) reasons.push("Multiple rounding rows were retained. Check for repeated summaries or conflicting adjustments; none was applied.");
  if (candidate) {
    if (candidate.cents === null) reasons.push("The labelled rounding amount is unreadable; it was retained without an applied amount.");
    else if (!candidate.signKnown) reasons.push("The nonzero rounding amount has no readable sign; confirm its sign before applying it.");
    if (candidate.cents !== null && Math.abs(candidate.cents) > 5) reasons.push("The rounding adjustment exceeds 5 cents; review it before applying it.");
    const inFinalSummary = lastProduct >= 0 && candidate.index > lastProduct
      && (lines.slice(lastProduct + 1, candidate.index).some((line) => SUMMARY.test(line.trim()))
        || lines.slice(candidate.index + 1).some((line) => FINAL_TOTAL.test(line.trim())));
    if (!inFinalSummary) reasons.push("The rounding row is not unambiguously associated with the final bill summary; it was not applied.");
  }
  const applied = candidate !== null && reasons.length === 0;
  const sources: SourceEvidence[] = candidates.map((row) => ({
    kind: "text", engine: "text", lineIndices: [row.index], text: row.line,
    ...(row.signKnown && row.cents !== null ? { observedValue: row.cents } : {}),
  }));
  const evidence: FieldEvidence = {
    origin: candidate?.signKnown && candidate.cents !== null ? "observed" : "unknown",
    needsReview: !applied,
    reasons,
    sources,
  };
  const retained = [...(receipt.rows ?? [])];
  candidates.forEach((row, index) => {
    const roundingRow: ReceiptRowEvidence = {
      id: `row-${row.index}`, role: "rounding", text: row.line.trim(),
      amountCents: row.cents, sources: [sources[index]!], needsReview: !applied,
    };
    const existing = retained.findIndex((old) => old.sources.some((source) => source.lineIndices?.includes(row.index)));
    if (existing === -1) retained.push(roundingRow);
    else retained[existing] = roundingRow;
  });
  const uncertainFields = new Set(receipt.uncertainFields ?? []);
  if (!applied) uncertainFields.add("rounding");
  return {
    ...receipt,
    roundingAdjustmentCents: candidate?.signKnown && isSafeSignedCents(candidate.cents) ? candidate.cents : null,
    roundingApplied: applied,
    evidence: { ...receipt.evidence, rounding: evidence },
    rows: retained,
    uncertainFields: [...uncertainFields],
    ocrWarnings: [...(receipt.ocrWarnings ?? []), ...reasons],
  };
}
