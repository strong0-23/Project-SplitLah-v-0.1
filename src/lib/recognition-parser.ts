import { parseReceiptText, type ParseResult } from "./parser";
import type { RecognitionDocument } from "./recognition-document";
import type { FieldEvidence, SourceEvidence } from "./types";
import { itemFieldNeedsReview } from "./receipt-quality";

/**
 * Shared interpretation entry point. Adapters own reading order/geometry only;
 * the same parser owns every financial decision for both engines.
 * Native confidence is deliberately not used as a shared probability.
 */
export function parseRecognitionDocument(document: RecognitionDocument): ParseResult {
  const parsed = parseReceiptText(document.text);
  const bindSource = (source: SourceEvidence): SourceEvidence => {
    const lines = (source.lineIndices ?? []).map(index => document.lines[index]).filter(line => !!line);
    const attempts = new Set(lines.map(line => line.source.attemptIndex));
    return {
      ...source,
      engine: document.engine,
      ...(attempts.size === 1 && lines[0]?.source.attemptIndex !== undefined ? { attemptIndex: lines[0].source.attemptIndex } : {}),
      boxIndices: [...new Set(lines.flatMap(line => line.source.boxIndices))],
    };
  };
  const bindEvidence = (evidence: FieldEvidence | undefined): FieldEvidence | undefined => {
    if (!evidence) return evidence;
    const uncertain = evidence.sources.some(source => source.lineIndices?.some(index => document.lines[index]?.uncertain));
    return { ...evidence, sources: evidence.sources.map(bindSource),
      needsReview: evidence.needsReview || uncertain,
      reasons: [...evidence.reasons, ...(uncertain ? ["Recognition layout/source association needs checking."] : [])],
    };
  };
  for (const item of parsed.receipt.items) {
    item.evidence = Object.fromEntries(Object.entries(item.evidence ?? {}).map(([key, evidence]) => [key, bindEvidence(evidence)]));
    item.flagged = !!item.flagged || (["description", "quantity", "unitPriceCents", "lineTotalCents", "role", "pricingBasis"] as const)
      .some(field => itemFieldNeedsReview(item, field));
  }
  parsed.receipt.evidence = Object.fromEntries(Object.entries(parsed.receipt.evidence ?? {}).map(([key, evidence]) => [key, bindEvidence(evidence)]));
  for (const row of parsed.receipt.rows ?? []) {
    // Keep harmless heading diagnostics separate from unresolved financial rows.
    if (row.role === "product" || row.role === "adjustment" || row.role === "ambiguous")
      row.needsReview ||= row.sources.some(source => source.lineIndices?.some(index => document.lines[index]?.uncertain));
    row.sources = row.sources.map(bindSource);
  }
  if (parsed.receipt.rows?.some(row => row.needsReview)) {
    const existing = parsed.receipt.evidence.rows;
    parsed.receipt.evidence.rows = { origin: existing?.origin ?? "observed", needsReview: true,
      reasons: [...existing?.reasons ?? [], "Check the highlighted receipt row classifications and associations."],
      sources: existing?.sources ?? [] };
  }
  return parsed;
}
