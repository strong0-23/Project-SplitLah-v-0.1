import { z } from "zod";
import type { Receipt } from "../../src/lib/types";
import { computeTotals } from "../../src/lib/bill";

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const knownCents = cents.nullish();
const path = z.string().min(1).refine((s) => !s.startsWith("/") && !s.includes("\\") && !s.split("/").includes(".."), "Use a relative path with forward slashes");
export const expectedSchema = z.object({
  // null or omitted means unverified, never a pass. An empty complete list means verified zero items.
  items: z.array(z.object({
    description: z.string().trim().min(1),
    quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
    lineTotalCents: knownCents,
    unitPriceCents: knownCents, // reference metadata only; the application does not extract unit prices
  }).strict()).nullish(),
  itemsComplete: z.boolean().default(false),
  discountCents: knownCents,
  serviceChargeCents: knownCents,
  gstCents: knownCents,
  gstInclusive: z.boolean().nullish(),
  payableTotalCents: knownCents,
}).strict();
export const datasetSchema = z.object({
  schemaVersion: z.literal(1),
  receipts: z.array(z.object({
    id: z.string().min(1),
    image: path.optional(),
    transcript: path.optional(),
    notes: z.string().optional(),
    scanOptions: z.object({
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).nullable().default(null),
      crop: z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).strict().refine((c) => c.left < c.right && c.top < c.bottom, "Crop must have positive area").nullable().default(null),
    }).strict().default({ rotation: null, crop: null }),
    expected: expectedSchema,
  }).strict()).min(1),
}).strict().refine((d) => new Set(d.receipts.map((r) => r.id)).size === d.receipts.length, "Receipt IDs must be unique");
export type Expected = z.infer<typeof expectedSchema>;
export type Case = z.infer<typeof datasetSchema>["receipts"][number];
export type Check = { key: string; status: "pass" | "fail" | "unknown"; expected?: unknown; actual?: unknown; delta?: number };
export function evaluate(expected: Expected, actual: Receipt | null): Check[] {
  const checks: Check[] = [];
  const check = (key: string, want: unknown, got: unknown) => checks.push({ key, status: want == null ? "unknown" : actual !== null && want === got ? "pass" : "fail", expected: want ?? null, actual: got ?? null, ...(typeof want === "number" && typeof got === "number" ? { delta: got - want } : {}) });
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  const unused = new Set((actual?.items ?? []).map((_, i) => i));
  const occurrences = new Map<string, number>();
  if (expected.items == null) check("items", null, actual?.items.length);
  else for (const item of expected.items) {
    const name = norm(item.description);
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const key = `item:${name}#${occurrence}`;
    // Exact names after whitespace/case normalization; duplicate names match in printed order.
    const index = [...unused].find((i) => norm(actual!.items[i]!.description) === name);
    const found = index === undefined ? undefined : actual!.items[index];
    if (index !== undefined) unused.delete(index);
    check(`${key}:present`, true, !!found);
    const quantityUnknown = found?.quantityExact === null || found?.evidence?.quantity?.origin === "unknown" || found?.evidence?.quantity?.origin === "defaulted";
    check(`${key}:quantity`, item.quantity, quantityUnknown ? null : found?.quantity);
    check(`${key}:lineTotalCents`, item.lineTotalCents, found?.lineTotalCents);
    // A printed unit price is useful for human verification, never a scanner pass.
    checks.push({ key: `${key}:unitPriceCents (reference only)`, status: "unknown", expected: item.unitPriceCents ?? null });
  }
  if (expected.items != null && expected.itemsComplete) {
    for (const i of unused) check(`extra:${i}:${norm(actual!.items[i]!.description)}`, false, true);
    check("extraItemCount", 0, unused.size);
  } else check("extraItemCount (incomplete reference)", null, unused.size);
  const totals = actual ? computeTotals(actual) : null;
  check("discountCents", expected.discountCents, actual?.discountCents);
  check("serviceChargeCents", expected.serviceChargeCents, actual && !actual.serviceEnabled ? 0 : actual?.chargeMode === "receipt" ? actual.serviceAmountCents : totals?.ok ? totals.value.serviceCents : null);
  check("gstCents", expected.gstCents, actual && !actual.gstEnabled ? 0 : actual?.chargeMode === "receipt" ? actual.gstAmountCents : totals?.ok ? totals.value.gstAddedCents + totals.value.gstIncludedCents : null);
  check("gstInclusive", expected.gstInclusive, actual?.gstInclusive);
  check("printedPayableTotalCents", expected.payableTotalCents, actual?.receiptTotalCents);
  check("computedPayableTotalCents", expected.payableTotalCents, totals?.ok ? totals.value.totalCents : null);
  return checks;
}

export const checkSchema = z.object({ key: z.string(), status: z.enum(["pass", "fail", "unknown"]), expected: z.unknown().optional(), actual: z.unknown().optional(), delta: z.number().optional() });
// Only this subset of imported reports is trusted for baseline comparisons.
export const baselineSchema = z.object({
  schemaVersion: z.literal(1), mode: z.enum(["ocr", "parser"]), revision: z.string(),
  results: z.array(z.object({ id: z.string(), fingerprint: z.string(), checks: z.array(checkSchema), error: z.object({ stage: z.string(), message: z.string() }).nullable() })),
});
export type Baseline = z.infer<typeof baselineSchema>;
export function compare(current: { mode: string; results: Baseline["results"] }, baseline: Baseline) {
  if (current.mode !== baseline.mode) return ["Not comparable: OCR and parser runs are separate."];
  const changes: string[] = [];
  for (const result of current.results) {
    const old = baseline.results.find((r) => r.id === result.id);
    if (!old) { changes.push(`${result.id}: new receipt (no baseline)`); continue; }
    if (!old.fingerprint || !result.fingerprint || old.fingerprint !== result.fingerprint) { changes.push(`${result.id}: not comparable (input unavailable, or input, scan options or reference changed)`); continue; }
    if (!!old.error !== !!result.error) changes.push(`${result.id}: ${result.error ? "REGRESSION: new error" : "IMPROVEMENT: error resolved"}`);
    for (const c of result.checks) {
      const previous = old.checks.find((p) => p.key === c.key);
      if (!previous || previous.status === c.status) continue;
      const direction = previous.status === "fail" && c.status === "pass" ? "IMPROVEMENT" : previous.status === "pass" && c.status === "fail" ? "REGRESSION" : "CHANGED";
      changes.push(`${result.id}: ${direction} ${c.key}: ${previous.status} -> ${c.status}`);
    }
  }
  for (const old of baseline.results) if (!current.results.some((r) => r.id === old.id)) changes.push(`${old.id}: absent from current run`);
  return changes.length ? changes : ["No scored improvements or regressions on comparable receipts."];
}
