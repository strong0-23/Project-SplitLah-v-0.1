/**
 * The rework parser (`src/lib/scan`, what the app ships) as a `ParserUnderTest`, scored with the
 * app's own bill arithmetic. Kept apart from `parsers.ts` so the engine comparison and the phone
 * timing page can score the app's parser without pulling in the parser-v2 baseline copy.
 */
import { computeTotals as reworkTotals } from "../../src/lib/bill";
import { parseReceiptText as reworkParse } from "../../src/lib/scan/parse";
import type { Receipt as ReworkReceipt } from "../../src/lib/types";
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
