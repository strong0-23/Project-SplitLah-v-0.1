/**
 * Extra correction actions for one receipt (Phase 2c, owner-confirmed 11 Nov 2026). Pure.
 *
 * Counted against the owner's verified reference, from the checks `evaluate` (model.ts) produces,
 * so product matching is the harness's existing matching, unchanged. Only checks whose reference
 * field is "known" can fail, so unknown fields never count. One action per Review-screen field fix
 * a user must make to reach a correct bill:
 *   +1 per missing reference product (add)
 *   +1 per extra product row (delete); only when the reference says every product row is listed
 *   +1 per wrong quantity on a matched product
 *   +1 per wrong line amount on a matched product
 *   +1 per wrong charge field: discount, service, GST amount, GST inclusive/exclusive
 *   +1 if the printed total field is wrong
 * The calculated total is derived from the other fields and is never an action.
 *
 * This simplifies the owner's earlier proof-bound evaluator (approved-comparison-r1) while keeping
 * all of its thresholds (≤ 2 corrections, +10 points, 8 s, 70% stop rule).
 */
import type { Check } from "./model";

export interface Corrections {
  /** Sum of the actions below. */
  total: number;
  missing: number;
  extra: number;
  quantity: number;
  amount: number;
  charges: number;
  printedTotal: number;
}

/** The threshold of decision rule (b) and the 70% stop rule. */
export const MAX_CORRECTIONS = 2;

const CHARGE_KEYS = new Set(["discountCents", "serviceChargeCents", "gstCents", "gstInclusive"]);
const ITEM = /^(item:.*#\d+):(present|quantity|lineTotalCents)$/;

export function countCorrections(checks: readonly Check[]): Corrections {
  const out: Corrections = {
    total: 0,
    missing: 0,
    extra: 0,
    quantity: 0,
    amount: 0,
    charges: 0,
    printedTotal: 0,
  };
  const present = new Map<string, Check["status"]>();
  for (const c of checks) {
    const m = ITEM.exec(c.key);
    if (m && m[2] === "present") present.set(m[1]!, c.status);
  }
  for (const c of checks) {
    if (c.status !== "fail") continue;
    const m = ITEM.exec(c.key);
    if (m) {
      if (m[2] === "present") out.missing++;
      // A missing product is one "add" action; its quantity and amount are entered with it.
      else if (present.get(m[1]!) === "pass") {
        if (m[2] === "quantity") out.quantity++;
        else out.amount++;
      }
    } else if (c.key.startsWith("extra:")) out.extra++;
    else if (CHARGE_KEYS.has(c.key)) out.charges++;
    else if (c.key === "printedPayableTotalCents") out.printedTotal++;
    // computedPayableTotalCents and extraItemCount are never actions.
  }
  out.total = out.missing + out.extra + out.quantity + out.amount + out.charges + out.printedTotal;
  return out;
}

/** Silent financial errors (rule a): failed checks with no review signal, as `evaluate` marks them. */
export const countSilent = (checks: readonly Check[]) => checks.filter((c) => c.silent).length;
