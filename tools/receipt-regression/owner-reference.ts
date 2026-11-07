/**
 * The owner's verified reference format (`reference-format/`): pairing photos with references,
 * contract validation, and conversion into the harness's scoring shape (`Expected`). Pure.
 *
 * Rules (owner, 8 Nov 2026):
 * - Every reference is checked with `validateReference` from `reference-format/reference-contract.mjs`
 *   (unchanged). One failing reference refuses the whole run. Errors carry paths and codes only.
 * - Only fields whose state is "known" are scored. Every other state (not_printed, illegible,
 *   not_applicable, not_yet_verified) is unscored: it never earns or loses points
 *   (`POLICY.unknownReferenceCredit` is false).
 * - Photos: `REG001.jpg` … in the photos folder. Any other file there (for example the older
 *   `*.reference.private.json`) is ignored and never read.
 * - References: `REG001.owner-inventory-v2.reference.private.json` … in the references folder.
 */
import {
  POLICY,
  validateReference,
  type ContractError,
} from "./reference-format/reference-contract.mjs";
import { expectedSchema, type Expected } from "./model";

export const PHOTO_FILE = /^(REG\d{3,})\.(?:jpe?g|png|webp)$/i;
export const REFERENCE_FILE = /^(REG\d{3,})\.owner-inventory-v(\d+)\.reference\.private\.json$/i;

export interface Pairing {
  pairs: Array<{ id: string; photo: string; reference: string }>;
  /** IDs with a photo but no reference, or a reference but no photo. */
  unpaired: Array<{ id: string; missing: "photo" | "reference" }>;
  /** IDs with several reference versions: the highest version is used and listed here. */
  versionNotes: string[];
}

/** Pairs photo and reference file NAMES by REG id. Never reads file contents. */
export function pairFiles(photoNames: string[], referenceNames: string[]): Pairing {
  const photos = new Map<string, string>();
  for (const name of photoNames) {
    const m = PHOTO_FILE.exec(name);
    if (m) photos.set(m[1]!.toUpperCase(), name);
  }
  const refs = new Map<string, { name: string; version: number; all: string[] }>();
  for (const name of referenceNames) {
    const m = REFERENCE_FILE.exec(name);
    if (!m) continue;
    const id = m[1]!.toUpperCase();
    const version = Number(m[2]);
    const prev = refs.get(id);
    const all = [...(prev?.all ?? []), name];
    refs.set(id, !prev || version > prev.version ? { name, version, all } : { ...prev, all });
  }
  const ids = [...new Set([...photos.keys(), ...refs.keys()])].sort();
  const out: Pairing = { pairs: [], unpaired: [], versionNotes: [] };
  for (const id of ids) {
    const photo = photos.get(id);
    const ref = refs.get(id);
    if (photo && ref) out.pairs.push({ id, photo, reference: ref.name });
    else out.unpaired.push({ id, missing: photo ? "reference" : "photo" });
    if (ref && ref.all.length > 1)
      out.versionNotes.push(`${id}: using ${ref.name} (of ${ref.all.length} versions)`);
  }
  return out;
}

/** The reference keys this module reads (the format has more; unread keys are ignored). */
type Key =
  | "state"
  | "value"
  | "value_cents"
  | "annotation"
  | "receipt_id"
  | "inventory_verification"
  | "products"
  | "row_kind"
  | "description"
  | "quantity"
  | "full_line_amount"
  | "reference_row_id"
  | "all_product_rows_accounted_for"
  | "discounts"
  | "all_discounts_accounted_for"
  | "printed_amount"
  | "scope"
  | "already_reflected_in_full_line_amounts"
  | "applies_to_reference_row_ids"
  | "all_charges_and_taxes_accounted_for"
  | "charges"
  | "kind"
  | "already_included_in_full_line_amounts"
  | "gst"
  | "inclusion_mode"
  | "printed_payable_total"
  | "preparation_extension"
  | "rounding"
  | "inventory_complete"
  | "adjustments"
  | "signed_amount"
  | "already_reflected_in_printed_payable_total";
type Json = { [K in Key]?: unknown };
type Field = { state?: unknown; value?: unknown; value_cents?: unknown } | undefined | null;
const isKnown = (f: Field): f is { state: "known"; value?: unknown; value_cents?: unknown } =>
  !!f && typeof f === "object" && f.state === "known";
const knownValue = (f: Field): unknown => (isKnown(f) ? f.value : undefined);
const knownCents = (f: Field): number | undefined =>
  isKnown(f) && Number.isSafeInteger(f.value_cents) ? (f.value_cents as number) : undefined;
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

export interface ReferenceCheck {
  ok: boolean;
  /** Contract errors (paths and codes only), plus a receipt-id mismatch if any. */
  errors: ContractError[];
}

/** Validates one reference with the owner's contract. A known receipt_id must match the file's REG id. */
export function checkReference(reference: unknown, regId: string): ReferenceCheck {
  const result = validateReference(reference);
  const errors = [...result.errors];
  const rid = knownValue(obj(obj(reference).annotation).receipt_id as Field);
  if (typeof rid === "string" && rid.trim().toUpperCase() !== regId.toUpperCase())
    errors.push({ path: "$.annotation.receipt_id", code: "receipt_id_does_not_match_file_name" });
  return { ok: errors.length === 0, errors };
}

export interface Converted {
  expected: Expected;
  /** Why some known content could not be scored (counts and codes only, no values). */
  notes: string[];
}

/**
 * Converts a VALID reference into `Expected`, using known fields only.
 * - items: purchase rows with a known description. Quantity only when known and a whole number;
 *   line amount only when known. A known return row is not scored (the app has no returns).
 * - itemsComplete: all_product_rows_accounted_for is known true and every purchase row is scorable.
 * - discounts: scored only when all_discounts_accounted_for is known true and every discount's
 *   amount, scope and "already reflected" flag is known. Item-scope discounts not reflected in the
 *   line amount are attached to their row, so either placement (on the item, D2; or on the bill)
 *   scores the same when the amounts agree.
 * - service: charges that are not GST/tax (D6: delivery and platform fees count as service), only
 *   when all_charges_and_taxes_accounted_for is known true and each amount is known.
 * - GST: printed amount and inclusion mode (included → true, added → false, mixed → unscored).
 * - payable total: printed_payable_total. Rounding (preparation_extension.rounding) is used only
 *   when its inventory is known complete, so the rework (D4, unrounded total) is scored fairly.
 */
export function toExpected(reference: unknown): Converted {
  const ref = obj(reference);
  const notes: string[] = [];
  const inventory = obj(ref.inventory_verification);
  const products = arr(ref.products);

  type Item = {
    id: string;
    description: string;
    quantity: number | null;
    lineTotalCents: number | null;
    itemDiscountCents?: number;
  };
  const items: Item[] = [];
  let unscorableRows = 0;
  let returns = 0;
  let fractional = 0;
  for (const p of products) {
    const kind = knownValue(p.row_kind as Field);
    if (kind === "return") {
      returns++;
      continue;
    }
    const description = knownValue(p.description as Field);
    if (typeof description !== "string" || !description.trim()) {
      unscorableRows++;
      continue;
    }
    const q = knownValue(p.quantity as Field) as
      { numerator?: number; denominator?: number } | undefined;
    let quantity: number | null = null;
    if (q && q.denominator === 1 && Number.isSafeInteger(q.numerator) && q.numerator! > 0)
      quantity = q.numerator!;
    else if (q) fractional++;
    const line = knownCents(p.full_line_amount as Field);
    items.push({
      id: String(p.reference_row_id ?? ""),
      description,
      quantity,
      lineTotalCents: line ?? null,
    });
  }
  if (returns) notes.push(`${returns} return row(s) not scored (the app has no return rows)`);
  if (unscorableRows)
    notes.push(`${unscorableRows} product row(s) without a known description not scored`);
  if (fractional) notes.push(`${fractional} fractional quantity(ies) not scored`);
  const rowsComplete = knownValue(inventory.all_product_rows_accounted_for as Field) === true;
  const itemsComplete = rowsComplete && unscorableRows === 0 && returns === 0;

  // Discounts.
  let discountCents: number | null = null;
  const discounts = arr(ref.discounts).filter((d) =>
    Object.values(d).some((v) => obj(v).state !== "not_yet_verified" && obj(v).state !== undefined),
  );
  if (knownValue(inventory.all_discounts_accounted_for as Field) === true) {
    let receiptLevel = 0;
    let ok = true;
    const itemLevel = new Map<string, number>();
    for (const d of discounts) {
      const amount = knownCents(d.printed_amount as Field);
      const scope = knownValue(d.scope as Field);
      const reflected = knownValue(d.already_reflected_in_full_line_amounts as Field);
      if (
        amount === undefined ||
        (scope !== "item" && scope !== "receipt") ||
        typeof reflected !== "boolean"
      ) {
        ok = false;
        break;
      }
      if (reflected) continue;
      if (scope === "receipt") receiptLevel += Math.abs(amount);
      else {
        const rows = knownValue(d.applies_to_reference_row_ids as Field);
        const row = Array.isArray(rows) && rows.length === 1 ? String(rows[0]) : null;
        if (!row || !items.some((it) => it.id === row)) {
          ok = false;
          break;
        }
        itemLevel.set(row, (itemLevel.get(row) ?? 0) + Math.abs(amount));
      }
    }
    if (ok) {
      discountCents = receiptLevel;
      for (const it of items)
        if (itemLevel.has(it.id)) it.itemDiscountCents = itemLevel.get(it.id)!;
    } else notes.push("discounts not scored (some discount amount, scope or row is not known)");
  }

  // Service (non-tax charges, D6).
  let serviceChargeCents: number | null = null;
  if (knownValue(inventory.all_charges_and_taxes_accounted_for as Field) === true) {
    let sum = 0;
    let ok = true;
    for (const c of arr(ref.charges).filter((c) =>
      Object.values(c).some(
        (v) => obj(v).state !== "not_yet_verified" && obj(v).state !== undefined,
      ),
    )) {
      const kind = knownValue(c.kind as Field);
      const amount = knownCents(c.printed_amount as Field);
      const included = knownValue(c.already_included_in_full_line_amounts as Field);
      if (typeof kind !== "string" || amount === undefined || typeof included !== "boolean") {
        ok = false;
        break;
      }
      if (/gst|tax|vat/i.test(kind) || included) continue;
      sum += amount;
    }
    if (ok) serviceChargeCents = sum;
    else
      notes.push("service charges not scored (some charge kind, amount or inclusion is not known)");
  }

  const gst = obj(ref.gst);
  const mode = knownValue(gst.inclusion_mode as Field);
  const gstInclusive = mode === "included" ? true : mode === "added" ? false : null;
  const payable = knownCents(ref.printed_payable_total as Field);

  let roundingCents: number | null = null;
  const rounding = obj(obj(ref.preparation_extension).rounding);
  if (knownValue(rounding.inventory_complete as Field) === true) {
    let sum = 0;
    let ok = true;
    for (const a of arr(rounding.adjustments).filter((a) =>
      Object.values(a).some(
        (v) => obj(v).state !== "not_yet_verified" && obj(v).state !== undefined,
      ),
    )) {
      const amount = knownCents(a.signed_amount as Field);
      const reflected = knownValue(a.already_reflected_in_printed_payable_total as Field);
      if (amount === undefined || typeof reflected !== "boolean") {
        ok = false;
        break;
      }
      if (reflected) sum += amount;
    }
    roundingCents = ok ? sum : null;
  }

  const expected = expectedSchema.parse({
    items: items.map(({ id: _id, ...it }) => it),
    itemsComplete,
    discountCents,
    serviceChargeCents,
    gstCents: knownCents(gst.printed_amount as Field) ?? null,
    gstInclusive,
    payableTotalCents: payable === undefined ? null : payable,
    roundingCents,
  });
  return { expected, notes };
}

/** The owner's policy: a field that isn't known never earns or loses points. */
export const UNKNOWN_REFERENCE_CREDIT = POLICY.unknownReferenceCredit;
