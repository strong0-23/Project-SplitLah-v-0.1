/**
 * The two parsers the merge gate compares, each scored with its OWN bill arithmetic. Both receive
 * exactly the same text (a verified transcript, or one OCR reading), so the comparison measures the
 * parser alone.
 *
 * - rework:    the app's current parser, `src/lib/scan` (what this branch ships).
 * - parser-v2: a read-only copy of branch parser-v2's parser at commit a80f7e3, in ./baseline.
 *              It is a baseline for this tool only; the app never imports it.
 */
import { computeTotals as reworkTotals } from "../../src/lib/bill";
import { parseReceiptText as reworkParse } from "../../src/lib/scan/parse";
import type { Receipt as ReworkReceipt } from "../../src/lib/types";
import { computeTotals as v2Totals } from "./baseline/parser-v2/bill";
import { parseReceiptText as v2Parse } from "./baseline/parser-v2/parser";
import type { Receipt as V2Receipt } from "./baseline/parser-v2/types";
import type { ParserUnderTest } from "./model";

export const rework: ParserUnderTest<ReworkReceipt> = {
  id: "rework",
  label: "rework",
  parse: (text) => reworkParse(text),
  computeTotals: (r) => reworkTotals(r),
  // The rework has no "unknown quantity" field: the quantity shown is the one the bill uses
  // (a doubtful one is flagged, and flags are scored as review signals, not as passes).
  knownQuantity: (item) => item.quantity,
  splitsUnroundedTotal: true, // D4
};

export const parserV2: ParserUnderTest<V2Receipt> = {
  id: "parser-v2",
  label: "parser-v2",
  parse: (text) => v2Parse(text),
  computeTotals: (r) => {
    const t = v2Totals(r);
    return t.ok
      ? {
          ok: true,
          value: {
            serviceCents: t.value.serviceCents,
            gstAddedCents: t.value.gstAddedCents,
            gstIncludedCents: t.value.gstIncludedCents,
            totalCents: t.value.totalCents,
            mismatchCents: t.value.mismatchCents,
          },
        }
      : t;
  },
  // parser-v2's own rule: an unidentified quantity (quantityExact null, or an unknown/defaulted
  // evidence origin) is not a known quantity, even though it displays 1.
  knownQuantity: (item) =>
    item.quantityExact === null ||
    item.evidence?.quantity?.origin === "unknown" ||
    item.evidence?.quantity?.origin === "defaulted"
      ? null
      : item.quantity,
};

export const PARSERS = [parserV2, rework] as const;
