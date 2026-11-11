// Synthetic receipts and verified references for the smoke tests. INVENTED DATA ONLY.
// The PNGs are rendered as text onto a canvas in the browser (never a photo); the references are
// built from reference-format/reference-template.json and checked with the owner's unchanged
// contract.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReference } from "../reference-format/reference-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../../..");

/** Invented receipts. Amounts reconcile; names are deliberately unusual so leaks are easy to spot. */
export const RECEIPTS = [
  {
    id: "REG901",
    lines: [
      "SYNTHETIC CAFE",
      "Item              Qty   Amount",
      "KAYA TOAST SET     2      9.00",
      "ICED MILO          1      3.20",
      "Subtotal                 12.20",
      "Service Charge 10%        1.22",
      "GST 9%                    1.21",
      "Total                    14.63",
    ],
    products: [
      ["KAYA TOAST SET", 2, 900],
      ["ICED MILO", 1, 320],
    ],
    discounts: [],
    charges: [["service_charge", "Service Charge", 122]],
    gst: { cents: 121, mode: "added" },
    total: 1463,
  },
  {
    id: "REG902",
    lines: [
      "SAMPLE MART",
      "2 x APPLE JUICE           5.00",
      "RICE CRACKERS             3.50",
      "Subtotal                  8.50",
      "Discount                 -0.50",
      "Total                     8.00",
      "GST 9% incl.              0.66",
    ],
    products: [
      ["APPLE JUICE", 2, 500],
      ["RICE CRACKERS", 1, 350],
    ],
    discounts: [["Discount", 50]],
    charges: [],
    gst: { cents: 66, mode: "included" },
    total: 800,
  },
];
export const SECRETS = [
  ...RECEIPTS.flatMap((r) => r.products.map((p) => p[0])),
  "SYNTHETIC CAFE",
  "SAMPLE MART",
  "14.63",
  "12.20",
  "9.00",
  "3.20",
  "1.22",
  "1.21",
  "8.50",
  "0.66",
];

const evidence = { kind: "printed", location: "synthetic line" };
const K = (value) => ({ state: "known", value, evidence });
const KC = (value_cents) => ({ state: "known", value_cents, evidence });

function reference(template, r) {
  const ref = structuredClone(template);
  ref.annotation.written_independently_of_ocr = true;
  ref.annotation.receipt_id = K(r.id);
  ref.annotation.photo_condition_tags = K(["computer_rendered"]);
  for (const f of [
    "all_product_rows_accounted_for",
    "all_returns_and_adjustments_accounted_for",
    "all_discounts_accounted_for",
    "all_charges_and_taxes_accounted_for",
  ])
    ref.inventory_verification[f] = K(true);
  ref.products = r.products.map(([name, qty, cents], i) => {
    const p = structuredClone(template.products[0]);
    p.reference_row_id = `r${i + 1}`;
    p.description = { ...p.description, ...K(name) };
    p.row_kind = { ...p.row_kind, ...K("purchase") };
    p.quantity = {
      ...p.quantity,
      state: "known",
      value: { numerator: qty, denominator: 1 },
      evidence,
    };
    p.full_line_amount = { ...p.full_line_amount, state: "known", value_cents: cents, evidence };
    return p;
  });
  ref.discounts = r.discounts.map(([label, cents], i) => {
    const d = structuredClone(template.discounts[0]);
    d.reference_adjustment_id = `d${i + 1}`;
    d.description = { ...d.description, ...K(label) };
    d.scope = { ...d.scope, ...K("receipt") };
    d.printed_amount = { ...d.printed_amount, ...KC(cents) };
    d.already_reflected_in_full_line_amounts = {
      ...d.already_reflected_in_full_line_amounts,
      ...K(false),
    };
    return d;
  });
  ref.charges = r.charges.map(([kind, label, cents], i) => {
    const c = structuredClone(template.charges[0]);
    c.reference_charge_id = `c${i + 1}`;
    c.kind = { ...c.kind, ...K(kind) };
    c.description = { ...c.description, ...K(label) };
    c.printed_amount = { ...c.printed_amount, ...KC(cents) };
    c.already_included_in_full_line_amounts = {
      ...c.already_included_in_full_line_amounts,
      ...K(false),
    };
    return c;
  });
  ref.returns_and_adjustments = [];
  ref.gst.printed_amount = { ...ref.gst.printed_amount, ...KC(r.gst.cents) };
  ref.gst.inclusion_mode = { ...ref.gst.inclusion_mode, ...K(r.gst.mode) };
  ref.printed_payable_total = { ...ref.printed_payable_total, ...KC(r.total) };
  return ref;
}

/**
 * Writes REG901/REG902 PNGs (rendered in `page`) and their references to a new temporary folder.
 * Returns the folder and the file paths.
 */
export async function writeSynthetic(page) {
  const dir = await mkdtemp(path.join(tmpdir(), "splitlah-smoke-"));
  await mkdir(path.join(dir, "photos"));
  await mkdir(path.join(dir, "references"));
  const template = JSON.parse(
    await readFile(
      path.join(repo, "tools/receipt-regression/reference-format/reference-template.json"),
      "utf8",
    ),
  );
  const files = [];
  for (const r of RECEIPTS) {
    const ref = reference(template, r);
    const check = validateReference(ref);
    if (!check.valid)
      throw new Error(
        `synthetic reference ${r.id} fails the contract: ${JSON.stringify(check.errors)}`,
      );
    const refPath = path.join(
      dir,
      "references",
      `${r.id}.owner-inventory-v1.reference.private.json`,
    );
    await writeFile(refPath, JSON.stringify(ref, null, 2));
    const dataUrl = await page.evaluate((lines) => {
      const c = document.createElement("canvas");
      c.width = 760;
      c.height = 80 + lines.length * 46;
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#000";
      g.font = "28px 'DejaVu Sans Mono', monospace";
      lines.forEach((l, i) => g.fillText(l, 30, 60 + i * 46));
      return c.toDataURL("image/png");
    }, r.lines);
    const photoPath = path.join(dir, "photos", `${r.id}.png`);
    await writeFile(photoPath, Buffer.from(dataUrl.split(",")[1], "base64"));
    files.push({ id: r.id, photo: photoPath, reference: refPath });
  }
  return { dir, files };
}

/**
 * True when `text` contains `s`: names case-insensitively; amounts only when not part of a longer
 * number (log timestamps such as "20.660" would otherwise match "0.66" by chance).
 */
export const has = (text, s) =>
  /^\d+\.\d\d$/.test(s)
    ? new RegExp(`(?<![\\d.])${s.replace(".", "\\.")}(?![\\d])`).test(text)
    : text.toLowerCase().includes(s.toLowerCase());
