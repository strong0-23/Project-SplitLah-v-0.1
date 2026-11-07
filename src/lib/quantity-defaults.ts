import type { Receipt, ReceiptItem } from "./types";
import { confirmItemField, updateItemWithEvidence } from "./receipt-quality";
import { parseMoney } from "./money";

const countUnits = new Set(["count", "ea", "each", "pcs", "piece", "pieces", "unit", "units"]);
export function isCompatibleCountRow(item: ReceiptItem): boolean {
  return (item.rowKind === undefined || item.rowKind === "product")
    && (!item.unitOfMeasure || countUnits.has(item.unitOfMeasure.toLowerCase()))
    && (!item.priceBasis || countUnits.has(item.priceBasis.unit.toLowerCase()))
    && !/\b(?:weight|weighted|loose|per\s*(?:kg|g|l|ml))\b|\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l)\b/i.test(item.description)
    && (item.quantityExact === null || item.evidence?.quantity?.origin === "defaulted");
}

/** Conservative text-layout support: an explicit, aligned TWO-column heading and
 * at least two complete aligned product rows, with no fragments/quantity/weight
 * columns. Single-space OCR text alone cannot establish this layout. */
export function applyImplicitQuantityDefaults(receipt: Receipt, text: string): Receipt {
  const lines = text.split(/\r\n|\n|\r/);
  const header = lines.findIndex(line => /^\s*(?:description|products?|items?)\s{2,}(?:amount|line\s+total)\s*$/i.test(line));
  if (header < 0 || receipt.items.length < 2 || /\b(?:qty|quantity|qiy|qly|q1y|weight|unit\s*price)\b/i.test(text)) return receipt;
  if (receipt.rows?.some(row => row.role === "ambiguous" || (row.needsReview && row.role !== "product"))) return receipt;
  const columns: number[] = [];
  for (const item of receipt.items) {
    if (!isCompatibleCountRow(item) || item.quantityExact !== null || item.unitPriceCents != null || item.lineTotalCents === null
      || item.evidence?.description?.needsReview || item.evidence?.lineTotalCents?.needsReview
      || /\b\d+(?:[.,]\d+)?\b/.test(item.description)) return receipt;
    const indices = [...new Set(item.evidence?.description?.sources.flatMap(source => source.lineIndices ?? []) ?? [])];
    if (indices.length !== 1 || indices[0]! <= header) return receipt;
    const raw = lines[indices[0]!] ?? "";
    const row = /^(.*?)\s{2,}(?:S?\$\s*)?(\d+[.,]\d{2})\s*$/.exec(raw);
    if (!row || row[1]!.trim() !== item.description || parseMoney(row[2]!.replace(',', '.')) !== item.lineTotalCents) return receipt;
    columns.push(raw.lastIndexOf(row[2]!));
  }
  if (Math.max(...columns) - Math.min(...columns) > 2) return receipt;
  return { ...receipt, items: receipt.items.map(item => ({ ...item, quantity: 1,
    quantityExact: { numerator: 1, denominator: 1 }, quantityDefaultBasis: "implicit-layout", flagged: true,
    evidence: { ...item.evidence, quantity: { origin: "defaulted", needsReview: true,
      reasons: ["Aligned description/full-amount columns support an implicit count layout. Proposed 1 still requires your confirmation."],
      sources: [...item.evidence?.quantity?.sources ?? [], { kind: "text", engine: "text", lineIndices: [header], text: lines[header] }] } },
  })) };
}

export function eligibleQuantityDefaults(receipt: Receipt): ReceiptItem[] {
  // A persisted marker alone is not proof of layout support. Recheck the raw
  // two-column evidence, allowing earlier explicit confirmations of that same
  // default while keeping genuinely observed/mixed quantities disqualifying.
  const probe: Receipt = { ...receipt, items: receipt.items.map(item => item.quantityDefaultBasis === "implicit-layout"
    && (item.evidence?.quantity?.origin === "defaulted" || item.evidence?.quantity?.previousOrigin === "defaulted")
    ? { ...item, quantityExact: null, evidence: { ...item.evidence, quantity: { ...item.evidence.quantity!, origin: "unknown" } } } : item) };
  if (applyImplicitQuantityDefaults(probe, receipt.rawOcrText ?? "") === probe) return [];
  return receipt.items.filter(item => item.quantityDefaultBasis === "implicit-layout"
    && item.evidence?.quantity?.origin === "defaulted" && item.quantityExact?.numerator === 1
    && item.quantityExact.denominator === 1 && isCompatibleCountRow(item));
}
export function confirmQuantityDefaults(receipt: Receipt, ids: string[]): Receipt {
  const eligible = new Set(eligibleQuantityDefaults(receipt).map(item => item.id));
  return { ...receipt, items: receipt.items.map(item => ids.includes(item.id) && eligible.has(item.id) ? confirmItemField(item, "quantity") : item) };
}
/** Explicit user entry after checking a count row, never automatic recognition. */
export function applyUserQuantityOne(receipt: Receipt, ids: string[]): Receipt {
  return { ...receipt, items: receipt.items.map(item => ids.includes(item.id) && isCompatibleCountRow(item)
    ? confirmItemField(updateItemWithEvidence(item, { quantity: 1, quantityExact: { numerator: 1, denominator: 1 } }), "quantity") : item) };
}
