/**
 * Reference schema, scoring and the Batch 1b merge gate. Pure; no DOM, no OCR.
 *
 * Ported from branch parser-v2 (commit a80f7e3). Changes in Batch 1b:
 * - `evaluate` scores any parser's receipt through a `ParserUnderTest` (its own bill maths and
 *   its own notion of an unknown quantity), so parser-v2 and the rework are scored the same way.
 * - `summarise` adds the per-receipt summary scores and the silent-error count, and `gate` applies
 *   the owner's merge rule. Summaries carry receipt IDs and counts only, never receipt content.
 */
import { z } from "zod";

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const knownCents = cents.nullish();
const path = z
  .string()
  .min(1)
  .refine(
    (s) => !s.startsWith("/") && !s.includes("\\") && !s.split("/").includes(".."),
    "Use a relative path with forward slashes",
  );
export const expectedSchema = z
  .object({
    // null or omitted means unverified, never a pass. An empty complete list means verified zero items.
    items: z
      .array(
        z
          .object({
            description: z.string().trim().min(1),
            quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
            lineTotalCents: knownCents,
            unitPriceCents: knownCents, // reference metadata only; never scored
            // An item-scope discount printed separately from this row's line amount (owner format).
            // Either placement scores the same: taken off the item (D2) or left on the bill.
            itemDiscountCents: knownCents,
          })
          .strict(),
      )
      .nullish(),
    itemsComplete: z.boolean().default(false),
    discountCents: knownCents,
    serviceChargeCents: knownCents,
    gstCents: knownCents,
    gstInclusive: z.boolean().nullish(),
    payableTotalCents: knownCents,
    // Signed cash rounding already reflected in the printed payable total (owner format), if known.
    roundingCents: z.number().int().nullish(),
  })
  .strict();
export const datasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    receipts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            image: path.optional(),
            transcript: path.optional(),
            notes: z.string().optional(),
            scanOptions: z
              .object({
                rotation: z
                  .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
                  .nullable()
                  .default(null),
                crop: z
                  .object({
                    left: z.number().min(0).max(1),
                    top: z.number().min(0).max(1),
                    right: z.number().min(0).max(1),
                    bottom: z.number().min(0).max(1),
                  })
                  .strict()
                  .refine(
                    (c) => c.left < c.right && c.top < c.bottom,
                    "Crop must have positive area",
                  )
                  .nullable()
                  .default(null),
              })
              .strict()
              .default({ rotation: null, crop: null }),
            expected: expectedSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (d) => new Set(d.receipts.map((r) => r.id)).size === d.receipts.length,
    "Receipt IDs must be unique",
  );
export type Expected = z.infer<typeof expectedSchema>;
export type Case = z.infer<typeof datasetSchema>["receipts"][number];
export type Check = {
  key: string;
  status: "pass" | "fail" | "unknown";
  expected?: unknown;
  actual?: unknown;
  delta?: number;
  /** A failed check the app gives no review signal for (see `isSilent`). */
  silent?: boolean;
};

/** The fields both parsers' receipts share. */
export interface ScoredItem {
  description: string;
  quantity: number;
  lineTotalCents: number | null;
  flagged?: boolean | undefined;
}
export interface ScoredReceipt {
  items: ScoredItem[];
  discountCents: number;
  chargeMode: "percentage" | "receipt";
  serviceEnabled: boolean;
  serviceAmountCents: number | null;
  gstEnabled: boolean;
  gstAmountCents: number | null;
  gstInclusive: boolean;
  receiptTotalCents: number | null;
  uncertainFields?: string[] | undefined;
}
export type Totals =
  | {
      ok: true;
      value: {
        serviceCents: number;
        gstAddedCents: number;
        gstIncludedCents: number;
        totalCents: number;
        mismatchCents: number | null;
      };
    }
  | { ok: false; errors: string[] };

/** One parser, scored with its own bill arithmetic. */
export interface ParserUnderTest<R extends ScoredReceipt = ScoredReceipt> {
  id: "rework" | "parser-v2";
  label: string;
  parse(text: string): { receipt: R; warnings: string[] };
  computeTotals(r: R): Totals;
  /** null when the parser itself says the quantity is unknown (parser-v2's `quantityExact: null`). */
  knownQuantity(item: R["items"][number]): number | null;
  /** Splits on the unrounded total (D4): its totals are compared with payable − known rounding. */
  splitsUnroundedTotal?: boolean;
}

/**
 * Scores a parsed receipt against a verified reference. Unknown reference fields never pass.
 * Item names match exactly after case/whitespace normalisation; duplicates match in printed order.
 */
export function evaluate<R extends ScoredReceipt>(
  expected: Expected,
  actual: R | null,
  parser: Pick<ParserUnderTest<R>, "computeTotals" | "knownQuantity" | "splitsUnroundedTotal">,
): Check[] {
  /** Which actual item each expected item matched (for the silent-error rule). */
  const matched = new Map<string, number>();
  /** Item discounts this parser did not take off their item: then they belong in the bill discount. */
  let itemDiscountsOnBill = 0;
  const checks: Check[] = [];
  const check = (key: string, want: unknown, got: unknown) =>
    checks.push({
      key,
      status: want == null ? "unknown" : actual !== null && want === got ? "pass" : "fail",
      expected: want ?? null,
      actual: got ?? null,
      ...(typeof want === "number" && typeof got === "number" ? { delta: got - want } : {}),
    });
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
  const unused = new Set((actual?.items ?? []).map((_, i) => i));
  const occurrences = new Map<string, number>();
  if (expected.items == null) check("items", null, actual?.items.length);
  else
    for (const item of expected.items) {
      const name = norm(item.description);
      const occurrence = (occurrences.get(name) ?? 0) + 1;
      occurrences.set(name, occurrence);
      const key = `item:${name}#${occurrence}`;
      // Exact name first; otherwise the name followed by a note the app added in brackets
      // ("DRY MEE POK (MEMBER DISC -1.00)", D2/D3 notes).
      const index =
        [...unused].find((i) => norm(actual!.items[i]!.description) === name) ??
        [...unused].find((i) => norm(actual!.items[i]!.description).startsWith(`${name} (`));
      if (index !== undefined) matched.set(key, index);
      const found = index === undefined ? undefined : actual!.items[index];
      if (index !== undefined) unused.delete(index);
      check(`${key}:present`, true, !!found);
      check(`${key}:quantity`, item.quantity, found ? parser.knownQuantity(found) : null);
      let wantLine = item.lineTotalCents;
      const d = item.itemDiscountCents ?? 0;
      if (d > 0 && wantLine != null) {
        if (found && found.lineTotalCents === wantLine - d)
          wantLine -= d; // placed on the item (D2)
        else itemDiscountsOnBill += d;
      }
      check(`${key}:lineTotalCents`, wantLine, found?.lineTotalCents);
      checks.push({
        key: `${key}:unitPriceCents (reference only)`,
        status: "unknown",
        expected: item.unitPriceCents ?? null,
      });
    }
  if (expected.items != null && expected.itemsComplete) {
    for (const i of unused) check(`extra:${i}:${norm(actual!.items[i]!.description)}`, false, true);
    check("extraItemCount", 0, unused.size);
  } else check("extraItemCount (incomplete reference)", null, unused.size);
  const totals = actual ? parser.computeTotals(actual) : null;
  check(
    "discountCents",
    expected.discountCents == null ? null : expected.discountCents + itemDiscountsOnBill,
    actual?.discountCents,
  );
  check(
    "serviceChargeCents",
    expected.serviceChargeCents,
    actual && !actual.serviceEnabled
      ? 0
      : actual?.chargeMode === "receipt"
        ? actual.serviceAmountCents
        : totals?.ok
          ? totals.value.serviceCents
          : null,
  );
  check(
    "gstCents",
    expected.gstCents,
    actual && !actual.gstEnabled
      ? 0
      : actual?.chargeMode === "receipt"
        ? actual.gstAmountCents
        : totals?.ok
          ? totals.value.gstAddedCents + totals.value.gstIncludedCents
          : null,
  );
  check("gstInclusive", expected.gstInclusive, actual?.gstInclusive);
  const payable =
    expected.payableTotalCents == null
      ? null
      : expected.payableTotalCents -
        (parser.splitsUnroundedTotal ? (expected.roundingCents ?? 0) : 0);
  check("printedPayableTotalCents", payable, actual?.receiptTotalCents);
  check("computedPayableTotalCents", payable, totals?.ok ? totals.value.totalCents : null);
  if (actual) for (const c of checks) c.silent = isSilent(c, actual, totals, matched);
  return checks;
}

/**
 * A silent error is a failed financial check that the app gives the user NO signal about:
 * - an item's quantity or line amount is wrong and the item is not flagged;
 * - an extra (unexpected) item is not flagged;
 * - an expected item is missing while the app says the receipt matches its total;
 * - the printed total is wrong and the total is not marked uncertain;
 * - the calculated total is wrong while the app says it matches the receipt total;
 * - the discount / service / GST is wrong and that field is not marked uncertain.
 */
function isSilent(
  c: Check,
  r: ScoredReceipt,
  totals: Totals | null,
  matched: Map<string, number>,
): boolean {
  if (c.status !== "fail") return false;
  const unsure = (f: string) => !!r.uncertainFields?.includes(f);
  const matches = !!totals?.ok && totals.value.mismatchCents === 0;
  const m = /^item:(.*)#\d+:(present|quantity|lineTotalCents)$/.exec(c.key);
  if (m) {
    if (m[2] === "present") return matches && !unsure("items");
    const at = matched.get(c.key.replace(/:(?:quantity|lineTotalCents)$/, ""));
    // A missing item is judged once, by its "present" check.
    return at !== undefined && !r.items[at]?.flagged;
  }
  const extra = /^extra:(\d+):/.exec(c.key);
  if (extra) return !r.items[Number(extra[1])]?.flagged;
  if (c.key === "printedPayableTotalCents") return !unsure("total");
  if (c.key === "computedPayableTotalCents") return matches;
  if (c.key === "discountCents") return !unsure("discount");
  if (c.key === "serviceChargeCents" || c.key === "gstCents" || c.key === "gstInclusive")
    return !unsure("charges");
  return false;
}

export interface SummaryScores {
  /** Expected items found / verified expected items; extra items when the reference is complete. */
  items: { found: number; of: number; extra: number | null };
  quantities: { pass: number; of: number };
  lineAmounts: { pass: number; of: number };
  printedTotal: Check["status"];
  calculatedTotal: Check["status"];
  silentErrors: number;
}

export function summarise(checks: Check[]): SummaryScores {
  const of = (suffix: string) =>
    checks.filter((c) => c.key.endsWith(suffix) && c.status !== "unknown");
  const pass = (list: Check[]) => list.filter((c) => c.status === "pass").length;
  const extra = checks.find((c) => c.key === "extraItemCount");
  const status = (key: string) => checks.find((c) => c.key === key)?.status ?? "unknown";
  return {
    items: {
      found: pass(of(":present")),
      of: of(":present").length,
      extra: extra && typeof extra.actual === "number" ? extra.actual : null,
    },
    quantities: { pass: pass(of(":quantity")), of: of(":quantity").length },
    lineAmounts: { pass: pass(of(":lineTotalCents")), of: of(":lineTotalCents").length },
    printedTotal: status("printedPayableTotalCents"),
    calculatedTotal: status("computedPayableTotalCents"),
    silentErrors: checks.filter((c) => c.silent).length,
  };
}

const rank = (s: Check["status"]) => (s === "pass" ? 1 : 0);

/**
 * The owner's merge rule (brief, Batch 1b task 8): the rework must match or beat parser-v2 on
 * EVERY receipt for items, quantities, line amounts, printed total, calculated total and silent
 * errors. Returns the metrics where the rework is worse (empty = this receipt passes).
 */
export function gate(rework: SummaryScores, baseline: SummaryScores): string[] {
  const worse: string[] = [];
  if (rework.items.found < baseline.items.found) worse.push("items found");
  if ((rework.items.extra ?? 0) > (baseline.items.extra ?? 0)) worse.push("extra items");
  if (rework.quantities.pass < baseline.quantities.pass) worse.push("quantities");
  if (rework.lineAmounts.pass < baseline.lineAmounts.pass) worse.push("line amounts");
  if (rank(rework.printedTotal) < rank(baseline.printedTotal)) worse.push("printed total");
  if (rank(rework.calculatedTotal) < rank(baseline.calculatedTotal)) worse.push("calculated total");
  if (rework.silentErrors > baseline.silentErrors) worse.push("silent errors");
  return worse;
}

/** One sanitised line per receipt: ID and counts only. Safe to send to the agent. */
export function summaryLine(id: string, label: string, s: SummaryScores): string {
  const extra = s.items.extra === null ? "" : `, ${s.items.extra} extra`;
  return `${id} | ${label}: items ${s.items.found}/${s.items.of}${extra}; qty ${s.quantities.pass}/${s.quantities.of}; amounts ${s.lineAmounts.pass}/${s.lineAmounts.of}; printed total ${s.printedTotal}; calculated total ${s.calculatedTotal}; silent errors ${s.silentErrors}`;
}

export const checkSchema = z.object({
  key: z.string(),
  status: z.enum(["pass", "fail", "unknown"]),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  delta: z.number().optional(),
  silent: z.boolean().optional(),
});
// Only this subset of imported reports is trusted for baseline comparisons.
export const baselineSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(["ocr", "parser"]),
  revision: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      parser: z.string().default("rework"),
      fingerprint: z.string(),
      checks: z.array(checkSchema),
      error: z.object({ stage: z.string(), message: z.string() }).nullable(),
    }),
  ),
});
export type Baseline = z.infer<typeof baselineSchema>;
export function compare(
  current: {
    mode: string;
    results: Array<Omit<Baseline["results"][number], "parser"> & { parser?: string }>;
  },
  baseline: Baseline,
) {
  if (current.mode !== baseline.mode) return ["Not comparable: OCR and parser runs are separate."];
  const changes: string[] = [];
  for (const result of current.results) {
    const parser = result.parser ?? "rework";
    const old = baseline.results.find((r) => r.id === result.id && r.parser === parser);
    if (!old) {
      changes.push(`${result.id} (${parser}): new receipt (no baseline)`);
      continue;
    }
    if (!old.fingerprint || !result.fingerprint || old.fingerprint !== result.fingerprint) {
      changes.push(
        `${result.id} (${parser}): not comparable (input unavailable, or input, scan options or reference changed)`,
      );
      continue;
    }
    if (!!old.error !== !!result.error)
      changes.push(
        `${result.id} (${parser}): ${result.error ? "REGRESSION: new error" : "IMPROVEMENT: error resolved"}`,
      );
    for (const c of result.checks) {
      const previous = old.checks.find((p) => p.key === c.key);
      if (!previous || previous.status === c.status) continue;
      const direction =
        previous.status === "fail" && c.status === "pass"
          ? "IMPROVEMENT"
          : previous.status === "pass" && c.status === "fail"
            ? "REGRESSION"
            : "CHANGED";
      changes.push(
        `${result.id} (${parser}): ${direction} ${c.key}: ${previous.status} -> ${c.status}`,
      );
    }
  }
  for (const old of baseline.results)
    if (!current.results.some((r) => r.id === old.id && (r.parser ?? "rework") === old.parser))
      changes.push(`${old.id} (${old.parser}): absent from current run`);
  return changes.length
    ? changes
    : ["No scored improvements or regressions on comparable receipts."];
}
