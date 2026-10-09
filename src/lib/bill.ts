import { allocateLargestRemainder, applyRate, includedTax, isSafeCents, MAX_QUANTITY } from "./money";
import type {
  BillCalculation,
  BillTotals,
  Cents,
  ItemAssignment,
  Participant,
  ParticipantBill,
  Receipt,
  ReceiptItem,
} from "./types";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function itemLabel(item: ReceiptItem, index: number): string {
  const d = item.description.trim();
  return d ? `“${d}” (line ${index + 1})` : `Line ${index + 1}`;
}

export function validateItems(items: ReceiptItem[]): string[] {
  const errors: string[] = [];
  if (items.length === 0) errors.push("Add at least one item.");
  items.forEach((it, i) => {
    const label = itemLabel(it, i);
    if (!it.description.trim()) errors.push(`${label}: enter a description.`);
    if (!Number.isSafeInteger(it.quantity) || it.quantity < 1 || it.quantity > MAX_QUANTITY)
      errors.push(`${label}: quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    if (it.lineTotalCents === null) errors.push(`${label}: enter the line total.`);
    else if (!isSafeCents(it.lineTotalCents)) errors.push(`${label}: line total is invalid.`);
  });
  return errors;
}

/** Compute bill-level totals from the receipt alone (no assignments needed). */
export function computeTotals(r: Receipt): Result<BillTotals> {
  const errors = validateItems(r.items);
  if (!isSafeCents(r.discountCents)) errors.push("Discount is invalid.");
  if (errors.length) return { ok: false, errors };

  const itemSubtotalCents = r.items.reduce((a, it) => a + (it.lineTotalCents as Cents), 0);
  const discountCents = r.discountCents;
  if (discountCents > itemSubtotalCents) errors.push("Discount cannot exceed the item subtotal.");

  const base = itemSubtotalCents - discountCents;
  let serviceCents = 0;
  let gstAddedCents = 0;
  let gstIncludedCents = 0;

  if (r.chargeMode === "percentage") {
    if (r.serviceEnabled) serviceCents = applyRate(Math.max(base, 0), r.serviceRateBp);
    if (r.gstEnabled) {
      const gstBase = Math.max(base, 0) + serviceCents;
      if (r.gstInclusive) gstIncludedCents = includedTax(gstBase, r.gstRateBp);
      else gstAddedCents = applyRate(gstBase, r.gstRateBp);
    }
  } else {
    if (r.serviceEnabled) {
      if (r.serviceAmountCents === null) errors.push("Enter the service charge amount from the receipt, or turn it off.");
      else if (!isSafeCents(r.serviceAmountCents)) errors.push("Service charge amount is invalid.");
      else serviceCents = r.serviceAmountCents;
    }
    if (r.gstEnabled) {
      if (r.gstAmountCents === null) errors.push("Enter the GST amount from the receipt, or turn it off.");
      else if (!isSafeCents(r.gstAmountCents)) errors.push("GST amount is invalid.");
      else if (r.gstInclusive) gstIncludedCents = r.gstAmountCents;
      else gstAddedCents = r.gstAmountCents;
    }
  }

  if (itemSubtotalCents === 0 && (serviceCents > 0 || gstAddedCents > 0 || gstIncludedCents > 0 || discountCents > 0))
    errors.push("Item subtotal is $0.00 but charges or a discount are entered. Add item prices or remove the charges.");

  if (errors.length) return { ok: false, errors };

  const totalCents = base + serviceCents + gstAddedCents;
  const mismatchCents = r.receiptTotalCents === null ? null : r.receiptTotalCents - totalCents;
  return {
    ok: true,
    value: { itemSubtotalCents, discountCents, serviceCents, gstAddedCents, gstIncludedCents, totalCents, mismatchCents },
  };
}

export type AllocationState = "unassigned" | "partial" | "complete" | "over" | "invalid";

export interface ItemAllocation {
  state: AllocationState;
  /** participantId -> cents (only meaningful when complete) */
  shares: Record<string, Cents>;
  allocatedCents: Cents;
  remainingCents: Cents;
  /** For quantity mode. */
  allocatedQty: number;
  message: string;
}

/** Determine how an item is allocated across valid participants. Pure. */
export function allocateItem(item: ReceiptItem, a: ItemAssignment | undefined, participants: Participant[]): ItemAllocation {
  const line = item.lineTotalCents ?? 0;
  const valid = new Set(participants.map((p) => p.id));
  const base = { shares: {}, allocatedCents: 0, remainingCents: line, allocatedQty: 0 };
  if (item.lineTotalCents === null) return { ...base, state: "invalid", message: "Line total missing" };
  if (!a) return { ...base, state: "unassigned", message: "Not assigned" };

  if (a.mode === "single" || a.mode === "even") {
    const ids = [...new Set(a.participantIds.filter((id) => valid.has(id)))].sort();
    if (ids.length === 0) return { ...base, state: "unassigned", message: "Not assigned" };
    if (a.mode === "single" && ids.length !== 1) return { ...base, state: "invalid", message: "Pick exactly one person" };
    const shares = allocateLargestRemainder(line, ids.map((id) => ({ id, weight: 1 })));
    return { shares, allocatedCents: line, remainingCents: 0, allocatedQty: item.quantity, state: "complete", message: ids.length > 1 ? `Split ${ids.length} ways` : "Assigned" };
  }

  if (a.mode === "quantity") {
    const entries = Object.entries(a.quantities).filter(([id]) => valid.has(id));
    for (const [, q] of entries)
      if (!Number.isSafeInteger(q) || q < 0) return { ...base, state: "invalid", message: "Quantities must be whole numbers ≥ 0" };
    const used = entries.filter(([, q]) => q > 0);
    const qty = used.reduce((s, [, q]) => s + q, 0);
    if (qty === 0) return { ...base, state: "unassigned", message: `0 of ${item.quantity} allocated` };
    if (qty > item.quantity) return { ...base, allocatedQty: qty, state: "over", message: `${qty} of ${item.quantity} allocated — too many` };
    if (qty < item.quantity) {
      const partial = Math.floor((line * qty) / item.quantity);
      return { ...base, allocatedQty: qty, allocatedCents: partial, remainingCents: line - partial, state: "partial", message: `${qty} of ${item.quantity} allocated` };
    }
    const shares = allocateLargestRemainder(line, used.map(([id, q]) => ({ id, weight: q })));
    return { shares, allocatedCents: line, remainingCents: 0, allocatedQty: qty, state: "complete", message: "All units allocated" };
  }

  // custom
  const entries = Object.entries(a.amounts).filter(([id]) => valid.has(id));
  for (const [, c] of entries) if (!isSafeCents(c)) return { ...base, state: "invalid", message: "Custom amounts must be valid, non-negative" };
  const sum = entries.reduce((s, [, c]) => s + c, 0);
  if (sum === 0 && line > 0) return { ...base, state: "unassigned", message: "No amounts entered" };
  if (sum > line) return { ...base, allocatedCents: sum, remainingCents: line - sum, state: "over", message: "Amounts exceed line total" };
  if (sum < line) return { ...base, allocatedCents: sum, remainingCents: line - sum, state: "partial", message: "Amounts below line total" };
  const shares: Record<string, Cents> = {};
  for (const [id, c] of entries) if (c > 0) shares[id] = c;
  if (line === 0 && Object.keys(shares).length === 0) {
    // $0 item: still needs at least one person listed to be "complete"
    if (entries.length === 0) return { ...base, state: "unassigned", message: "Not assigned" };
  }
  return { shares, allocatedCents: line, remainingCents: 0, allocatedQty: item.quantity, state: "complete", message: "Custom amounts match" };
}

function shareNote(item: ReceiptItem, a: ItemAssignment, pid: string, nWays: number): string {
  if (a.mode === "quantity") return `${a.quantities[pid]} of ${item.quantity}`;
  if (a.mode === "custom") return "custom amount";
  if (a.mode === "even" && nWays > 1) return `shared ${nWays} ways`;
  return item.quantity > 1 ? `×${item.quantity}` : "";
}

/** Full calculation. Returns errors if anything is incomplete, inconsistent or unreconciled. */
export function calculateBill(r: Receipt, participants: Participant[], assignments: Record<string, ItemAssignment>): Result<BillCalculation> {
  const totalsRes = computeTotals(r);
  if (!totalsRes.ok) return totalsRes;
  const totals = totalsRes.value;
  const errors: string[] = [];
  if (participants.length === 0) errors.push("Add at least one person.");
  if (totals.mismatchCents !== null && totals.mismatchCents !== 0)
    errors.push(`Calculated total differs from the receipt total by ${Math.abs(totals.mismatchCents)} cent(s). Correct the items or charges.`);

  const bills: Record<string, ParticipantBill> = {};
  for (const p of participants)
    bills[p.id] = { participantId: p.id, name: p.name, items: [], itemSubtotalCents: 0, discountCents: 0, serviceCents: 0, gstAddedCents: 0, gstIncludedCents: 0, owedCents: 0 };

  const B = (id: string): ParticipantBill => bills[id]!;
  r.items.forEach((item, i) => {
    const a = assignments[item.id];
    const alloc = allocateItem(item, a, participants);
    if (alloc.state !== "complete") {
      errors.push(`${itemLabel(item, i)}: ${alloc.message.toLowerCase()}.`);
      return;
    }
    const ids = Object.keys(alloc.shares);
    for (const pid of ids) {
      B(pid).itemSubtotalCents += alloc.shares[pid] ?? 0;
      B(pid).items.push({ itemId: item.id, description: item.description, cents: alloc.shares[pid] ?? 0, note: shareNote(item, a!, pid, ids.length) });
    }
  });
  if (errors.length) return { ok: false, errors };

  const ids = participants.map((p) => p.id);
  const w = (f: (b: ParticipantBill) => number) => ids.map((id) => ({ id, weight: f(B(id)) }));
  try {
    const disc = allocateLargestRemainder(totals.discountCents, w((b: ParticipantBill) => b.itemSubtotalCents));
    ids.forEach((id) => (B(id).discountCents = disc[id] ?? 0));
    const svc = allocateLargestRemainder(totals.serviceCents, w((b: ParticipantBill) => b.itemSubtotalCents - b.discountCents));
    ids.forEach((id) => (B(id).serviceCents = svc[id] ?? 0));
    const gstW = w((b: ParticipantBill) => b.itemSubtotalCents - b.discountCents + b.serviceCents);
    const gst = allocateLargestRemainder(totals.gstAddedCents, gstW);
    const inc = allocateLargestRemainder(totals.gstIncludedCents, gstW);
    ids.forEach((id) => {
      const b = B(id);
      b.gstAddedCents = gst[id] ?? 0;
      b.gstIncludedCents = inc[id] ?? 0;
      b.owedCents = b.itemSubtotalCents - b.discountCents + b.serviceCents + b.gstAddedCents;
    });
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : "Allocation failed."] };
  }

  const sum = ids.reduce((s, id) => s + B(id).owedCents, 0);
  if (sum !== totals.totalCents) return { ok: false, errors: ["Internal reconciliation failed."] };
  return { ok: true, value: { totals, participants: ids.map((id) => B(id)) } };
}
