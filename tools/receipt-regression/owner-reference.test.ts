/**
 * The owner's verified reference format, tested with SYNTHETIC references built from the committed
 * blank template (reference-format/reference-template.json) and checked with the unchanged contract.
 * No receipt data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { POLICY } from "./reference-format/reference-contract.mjs";
import { checkReference, pairFiles, toExpected, UNKNOWN_REFERENCE_CREDIT } from "./owner-reference";
import { evaluate, gate, summarise, type ParserUnderTest } from "./model";
import { parserV2, rework } from "./parsers";

type AnyJson = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const TEMPLATE: AnyJson = JSON.parse(
  readFileSync("tools/receipt-regression/reference-format/reference-template.json", "utf8"),
);
const evidence = { kind: "printed", location: "synthetic line" };
const K = (value: unknown) => ({ state: "known", value, evidence });
const KC = (value_cents: number) => ({ state: "known", value_cents, evidence });

function product(id: string, description: string, quantity: number, cents: number) {
  const p = structuredClone(TEMPLATE.products[0]);
  p.reference_row_id = id;
  p.description = { ...p.description, ...K(description) };
  p.row_kind = { ...p.row_kind, ...K("purchase") };
  p.quantity = {
    ...p.quantity,
    state: "known",
    value: { numerator: quantity, denominator: 1 },
    evidence,
  };
  p.full_line_amount = { ...p.full_line_amount, state: "known", value_cents: cents, evidence };
  return p;
}

/** Synthetic REG901: two products, an item discount printed under one, a delivery fee, GST added. */
const RECEIPT_TEXT = `SAMPLE NOODLE HOUSE
Item              Qty   Amount
DRY MEE POK        2    11.00
  MEMBER DISC          -1.00
FISHBALL SOUP      1     6.50
Subtotal                16.50
Delivery Fee             3.00
GST 9%                   1.76
Total                   21.26`;

function synthetic(): AnyJson {
  const r = structuredClone(TEMPLATE);
  r.annotation.written_independently_of_ocr = true;
  r.annotation.receipt_id = { ...K("REG901") };
  for (const f of [
    "all_product_rows_accounted_for",
    "all_returns_and_adjustments_accounted_for",
    "all_discounts_accounted_for",
    "all_charges_and_taxes_accounted_for",
  ])
    r.inventory_verification[f] = K(true);
  r.products = [product("r1", "DRY MEE POK", 2, 1100), product("r2", "FISHBALL SOUP", 1, 650)];
  const d = r.discounts[0];
  d.reference_adjustment_id = "d1";
  d.description = { ...d.description, ...K("MEMBER DISC") };
  d.scope = { ...d.scope, ...K("item") };
  d.applies_to_reference_row_ids = K(["r1"]);
  d.printed_amount = { ...d.printed_amount, ...KC(100) };
  d.already_reflected_in_full_line_amounts = {
    ...d.already_reflected_in_full_line_amounts,
    ...K(false),
  };
  const c = r.charges[0];
  c.reference_charge_id = "c1";
  c.kind = { ...c.kind, ...K("delivery_fee") };
  c.description = { ...c.description, ...K("Delivery Fee") };
  c.printed_amount = { ...c.printed_amount, ...KC(300) };
  c.already_included_in_full_line_amounts = {
    ...c.already_included_in_full_line_amounts,
    ...K(false),
  };
  r.gst.printed_amount = { ...r.gst.printed_amount, ...KC(176) };
  r.gst.inclusion_mode = { ...r.gst.inclusion_mode, ...K("added") };
  r.gst.rate_basis_points = { ...r.gst.rate_basis_points, ...K(900) };
  r.printed_payable_total = { ...r.printed_payable_total, ...KC(2126) };
  return r;
}

const score = (
  p: ParserUnderTest,
  expected: ReturnType<typeof toExpected>["expected"],
  text = RECEIPT_TEXT,
) => evaluate(expected, p.parse(text).receipt, p);
const asAny = (p: unknown) => p as ParserUnderTest;

describe("owner reference format: contract and policy", () => {
  it("keeps unknownReferenceCredit false", () => {
    expect(POLICY.unknownReferenceCredit).toBe(false);
    expect(UNKNOWN_REFERENCE_CREDIT).toBe(false);
  });

  it("accepts the blank template and the synthetic reference", () => {
    expect(checkReference(TEMPLATE, "REG901")).toEqual({ ok: true, errors: [] });
    expect(checkReference(synthetic(), "REG901")).toEqual({ ok: true, errors: [] });
  });

  it("refuses a reference that breaks the contract, reporting paths and codes only", () => {
    const bad = synthetic();
    bad.printed_payable_total = { state: "known", value_cents: 2126, evidence: null }; // no evidence
    const res = checkReference(bad, "REG901");
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual({
      path: "$.printed_payable_total",
      code: "known_requires_independent_evidence",
    });
    expect(JSON.stringify(res.errors)).not.toContain("2126");
  });

  it("refuses a reference whose known receipt_id doesn't match the file's REG id", () => {
    expect(checkReference(synthetic(), "REG902").errors).toContainEqual({
      path: "$.annotation.receipt_id",
      code: "receipt_id_does_not_match_file_name",
    });
  });
});

describe("owner reference format: scoring known fields only", () => {
  it("converts known fields, attaching the item discount to its row", () => {
    const { expected, notes } = toExpected(synthetic());
    expect(expected).toMatchObject({
      items: [
        { description: "DRY MEE POK", quantity: 2, lineTotalCents: 1100, itemDiscountCents: 100 },
        { description: "FISHBALL SOUP", quantity: 1, lineTotalCents: 650 },
      ],
      itemsComplete: true,
      discountCents: 0,
      serviceChargeCents: 300,
      gstCents: 176,
      gstInclusive: false,
      payableTotalCents: 2126,
      roundingCents: null,
    });
    expect(notes).toEqual([]);
  });

  it("scores the item discount the same on the item (rework, D2) or on the bill (parser-v2)", () => {
    const { expected } = toExpected(synthetic());
    const rw = score(asAny(rework), expected);
    expect(rw.filter((c) => c.status === "fail")).toEqual([]);
    const v2 = score(asAny(parserV2), expected);
    expect(v2.find((c) => c.key === "item:dry mee pok#1:lineTotalCents")?.status).toBe("pass");
    expect(v2.find((c) => c.key === "discountCents")).toMatchObject({
      status: "pass",
      expected: 100,
    });
    expect(gate(summarise(rw), summarise(v2))).toEqual([]);
  });

  it("never scores a field that is not known (illegible, not printed, not yet verified)", () => {
    const ref = synthetic();
    ref.products[0].quantity.state = "illegible";
    ref.products[0].quantity.value = null;
    ref.gst.printed_amount = {
      ...ref.gst.printed_amount,
      state: "not_yet_verified",
      value_cents: null,
      evidence: null,
    };
    ref.printed_payable_total = { state: "not_yet_verified", value_cents: null, evidence: null };
    expect(checkReference(ref, "REG901").ok).toBe(true);
    const { expected } = toExpected(ref);
    for (const p of [asAny(rework), asAny(parserV2)]) {
      const checks = score(p, expected);
      for (const key of [
        "item:dry mee pok#1:quantity",
        "gstCents",
        "printedPayableTotalCents",
        "computedPayableTotalCents",
      ])
        expect(checks.find((c) => c.key === key)?.status, `${p.id} ${key}`).toBe("unknown");
      expect(summarise(checks).quantities.of).toBe(1);
    }
  });

  it("does not score discounts when the discount inventory isn't known complete", () => {
    const ref = synthetic();
    ref.inventory_verification.all_discounts_accounted_for = {
      state: "not_yet_verified",
      value: null,
    };
    expect(toExpected(ref).expected.discountCents).toBeNull();
  });

  it("compares the rework with the unrounded total (D4) and parser-v2 with the payable", () => {
    const ref = synthetic();
    ref.preparation_extension.rounding.inventory_complete = K(true);
    const a = ref.preparation_extension.rounding.adjustments[0];
    a.reference_rounding_id = "rd1";
    a.label = { ...a.label, ...K("ROUNDING") };
    a.signed_amount = { ...a.signed_amount, ...KC(-1) };
    a.already_reflected_in_printed_payable_total = {
      ...a.already_reflected_in_printed_payable_total,
      ...K(true),
    };
    ref.printed_payable_total = { ...ref.printed_payable_total, value_cents: 2125 };
    expect(checkReference(ref, "REG901").ok).toBe(true);
    const { expected } = toExpected(ref);
    expect(expected).toMatchObject({ payableTotalCents: 2125, roundingCents: -1 });
    const text = RECEIPT_TEXT.replace(
      "Total                   21.26",
      "Total                   21.26\nRounding                -0.01\nTotal Due               21.25",
    );
    const rw = score(asAny(rework), expected, text);
    expect(rw.find((c) => c.key === "printedPayableTotalCents")).toMatchObject({
      status: "pass",
      expected: 2126,
    });
    const v2 = score(asAny(parserV2), expected, text);
    expect(v2.find((c) => c.key === "printedPayableTotalCents")?.expected).toBe(2125);
  });
});

describe("owner reference format: pairing photos and references by REG id", () => {
  it("pairs by REG id, ignores other files, and reports what is unpaired", () => {
    const p = pairFiles(
      ["REG001.jpg", "REG001.reference.private.json", "REG002.png", "notes.txt", "REG004.JPG"],
      [
        "REG001.owner-inventory-v1.reference.private.json",
        "REG001.owner-inventory-v2.reference.private.json",
        "REG003.owner-inventory-v2.reference.private.json",
        "REG004.owner-inventory-v2.reference.private.json",
        "README.md",
      ],
    );
    expect(p.pairs).toEqual([
      {
        id: "REG001",
        photo: "REG001.jpg",
        reference: "REG001.owner-inventory-v2.reference.private.json",
      },
      {
        id: "REG004",
        photo: "REG004.JPG",
        reference: "REG004.owner-inventory-v2.reference.private.json",
      },
    ]);
    expect(p.unpaired).toEqual([
      { id: "REG002", missing: "reference" },
      { id: "REG003", missing: "photo" },
    ]);
    expect(p.versionNotes).toEqual([
      "REG001: using REG001.owner-inventory-v2.reference.private.json (of 2 versions)",
    ]);
  });
});
