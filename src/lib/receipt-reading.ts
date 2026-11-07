import { parseReceiptText, receiptSummaryEvidence, type ParseResult } from "./parser";
import type { OcrResult } from "./ocr";
import { normaliseOcrToken, type OcrWord } from "./ocr-regions";
import { parseMoney } from "./money";
import { documentFromTesseract } from "./recognition-document";
import { parseRecognitionDocument } from "./recognition-parser";

export interface OcrParseResult extends ParseResult {
  recoveredItems?: { itemIndex: number; readingIndex: number; cents: number; observedQuantity: number; sourceAttempt: number; needsReview: true }[];
  recoveredTotal?: {
    attemptIndex: number;
    cents: number;
    totalLabel: string;
    paymentLabel: string;
    needsReview: true;
  };
}

/** Keep the selected reading's body. Only corroborated summary evidence may fill a missing total. */
export function parseOcrResult(ocr: OcrResult): OcrParseResult {
  return recoverItems(recoverTotal(ocr), ocr);
}

function recoverItems(parsed: OcrParseResult, ocr: OcrResult): OcrParseResult {
  // A signed target must never become positive when closer readings lose its
  // sign. An unrelated unresolved adjustment does not erase direct evidence
  // about a separately identified product's full line amount.
  if (ocr.attempts?.[ocr.selectedAttempt]?.text !== ocr.text) return parsed;
  const header = ocr.text.split(/\r?\n/).find(line => /\bunit(?:\s*\([^)]*\)|\s*price)?\b.*\b(?:qty|quantity)\b.*\bamount\b/i.test(line));
  const recovered: NonNullable<OcrParseResult["recoveredItems"]> = [];
  for (const [readingIndex, reading] of (ocr.itemReadings ?? []).entries()) {
    const item = parsed.receipt.items[reading.itemIndex];
    if (!item || item.rowKind === "ambiguous" || item.rowKind === "return" || item.rowKind === "adjustment"
      || item.lineTotalCents !== null || reading.error || reading.sourceAttempt !== ocr.selectedAttempt
      || item.description !== reading.description || reading.attempts.length < 2
      || new Set(reading.attempts.map(a => a.pageSegmentation)).size < 2
      || ocr.itemReadings!.filter(other => other.itemIndex === reading.itemIndex).length !== 1
      || parsed.receipt.items.filter(i => i.description === item.description).length !== 1) continue;
    const tokens = new Set(item.description.split(/\s+/).map(normaliseOcrToken).filter(t => (t.match(/[a-z]/g) ?? []).length >= 3
      && !parsed.receipt.items.some(other => other !== item && other.description.split(/\s+/).map(normaliseOcrToken).includes(t))));
    if (tokens.size < 2) continue;
    const regionItems = reading.attempts.map(a => parseReceiptText(`OCR ITEM REGION\n${header ?? "Product Qty Total"}\n${a.text}`).receipt.items);
    if (regionItems.some(items => items.length > 1)) continue;
    const candidates = regionItems.flat()
      .filter(i => i.lineTotalCents !== null);
    // A crop can include the target's unpriced name and a priced neighbouring row.
    // Bind the parsed priced descriptor itself to the target, not words elsewhere.
    if (candidates.some(i => new Set(i.description.split(/\s+/).map(normaliseOcrToken).filter(t => tokens.has(t))).size < 2)) continue;
    const values = new Set(candidates.map(i => `${i.quantity}:${i.lineTotalCents}`));
    if (values.size !== 1) continue;
    const candidate = candidates[0]!;
    const supports = (words: OcrWord[]) => {
      const shared = new Set(words.filter(w => w.confidence >= 70).map(w => normaliseOcrToken(w.text)).filter(t => tokens.has(t)));
      if (shared.size < 2) return false;
      const prices = words.filter(w => w.confidence >= 70 && /^\d+[.,]\d{2}$/.test(w.text) && parseMoney(w.text.replace(',', '.')) === candidate.lineTotalCents);
      return prices.some(price => {
        const overlaps = (w: OcrWord) => Math.abs((w.bbox.y0 + w.bbox.y1 - price.bbox.y0 - price.bbox.y1) / 2) < Math.max(w.bbox.y1 - w.bbox.y0, price.bbox.y1 - price.bbox.y0) * .7;
        if (words.some(w => /^[-−]$/.test(w.text) && overlaps(w))) return false;
        const quantities = words.filter(w => w.confidence >= 70 && /^\d{1,3}$/.test(w.text) && Number(w.text) === candidate.quantity && w.bbox.x1 < price.bbox.x0 && overlaps(w));
        return quantities.length === 1;
      });
    };
    if (reading.attempts.filter(a => supports(a.words)).length < 2) continue;
    item.lineTotalCents = candidate.lineTotalCents;
    item.flagged = true; // quantity and original description stay exactly as selected
    item.evidence = { ...item.evidence, lineTotalCents: { origin: "observed", needsReview: true,
      reasons: ["Recovered by closer readings; confirm its association with this product."],
      sources: [...(item.evidence?.lineTotalCents?.sources ?? []), ...reading.attempts.map(a => ({ kind: "geometry" as const, engine: "tesseract" as const, attemptIndex: reading.sourceAttempt, text: a.text.slice(0, 1000), observedValue: candidate.lineTotalCents }))] } };
    recovered.push({ itemIndex: reading.itemIndex, readingIndex, cents: candidate.lineTotalCents!, observedQuantity: candidate.quantity, sourceAttempt: reading.sourceAttempt, needsReview: true });
  }
  if (!recovered.length) return parsed;
  const missing = parsed.receipt.items.filter(i => i.lineTotalCents === null).length;
  parsed.warnings = ["A highlighted item's amount was read on a closer scan. Confirm its amount and quantity.",
    ...parsed.warnings.filter(w => !/^\d+ item line\(s\) were read without a price/.test(w)
      && !/^Couldn't tell whether tax is included or added \(items /.test(w)
      && !/^Items add up to /.test(w))];
  if (parsed.receipt.uncertainFields?.includes("charges")) parsed.warnings.push("Item amounts changed on a closer scan. Confirm service charge, GST and the printed total.");
  if (missing) parsed.warnings.push(`${missing} item line(s) were read without a price — enter the line total for highlighted items.`);
  parsed.receipt.ocrWarnings = parsed.warnings.slice(0, 20).map(w => w.slice(0, 300));
  return { ...parsed, recoveredItems: recovered };
}

function recoverTotal(ocr: OcrResult): OcrParseResult {
  const parsed = parseRecognitionDocument(documentFromTesseract(ocr));
  const r = parsed.receipt;
  if (r.receiptTotalCents !== null || !r.items.length
    || ocr.attempts?.[ocr.selectedAttempt]?.text !== ocr.text) return parsed;

  const summaries = ocr.attempts.map(a => receiptSummaryEvidence(a.text));
  if (summaries.some(s => s.totalAmbiguous)) return parsed;
  const amounts = new Set(summaries.flatMap(s => s.totals.map(t => t.cents)));
  if (amounts.size !== 1) return parsed; // conflicting or missing literal totals
  const cents = [...amounts][0]!;
  // Quantity uncertainty must not erase independently observed identity/amount
  // evidence. Nor may a compatibility placeholder 1 serve as quantity evidence.
  const anchored = (item: typeof r.items[number]) => item.lineTotalCents !== null
    && item.evidence?.description?.origin === "observed" && !item.evidence.description.needsReview
    && item.evidence?.lineTotalCents?.origin === "observed" && !item.evidence.lineTotalCents.needsReview;
  const anchor = (item: typeof r.items[number]) => JSON.stringify([item.description.toLowerCase().replace(/\s+/g, " ").trim(), item.lineTotalCents]);
  const anchors = new Map(r.items.filter(anchored).map(item => [anchor(item), item]));
  if (!anchors.size) return parsed;

  for (const [attemptIndex, summary] of summaries.entries()) {
    if (attemptIndex === ocr.selectedAttempt || summary.ambiguous || !summary.totals.length || summary.payments.length !== 1
      || summary.payments[0]!.cents !== cents) continue;
    const alternate = parseReceiptText(ocr.attempts[attemptIndex]!.text).receipt;
    if (alternate.items.length !== r.items.length
      || !alternate.items.some(item => {
        const selected = anchors.get(anchor(item));
        if (!selected || !anchored(item)) return false;
        const known = (i: typeof item) => i.evidence?.quantity?.origin === "observed" && !!i.quantityExact;
        return !(known(selected) && known(item)) || selected.quantity === item.quantity;
      })) continue;

    r.receiptTotalCents = cents;
    r.evidence = { ...r.evidence, total: { origin: "observed", needsReview: true,
      reasons: ["Printed total recovered from a different reading with payment corroboration; confirm it."],
      sources: [...(r.evidence?.total?.sources ?? []), { kind: "text", engine: "tesseract", attemptIndex, text: `${summary.totals[0]!.label}; corroboration: ${summary.payments[0]!.label}`, observedValue: cents }] } };
    // Keep every review flag, including total: this corroborated alternate still needs review.
    const warnings = ["The printed total was recovered from another reading with a matching electronic payment. Confirm the total; item uncertainties remain.",
      ...parsed.warnings.filter(w => w !== "Receipt total not found — enter it to check the maths.")];
    r.ocrWarnings = warnings.slice(0, 20).map(w => w.slice(0, 300));
    return { receipt: r, warnings, recoveredTotal: {
      attemptIndex, cents, totalLabel: summary.totals[0]!.label,
      paymentLabel: summary.payments[0]!.label, needsReview: true,
    } };
  }
  return parsed;
}
