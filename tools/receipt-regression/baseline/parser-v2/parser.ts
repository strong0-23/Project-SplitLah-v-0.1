import { parseMoney, parseRate } from "./money";
import type { FieldEvidence, RationalQuantity, Receipt, ReceiptItem, ReceiptRowEvidence, SourceEvidence, ValueOrigin } from "./types";
import { parseQuantity, quantityNumber, validatePriceRelationship } from "./quantity";
import { newId } from "./ids";
import { emptyReceipt } from "./defaults";
import { applyReceiptRounding, isReceiptRoundingLine } from "./receipt-rounding";
import { applyImplicitQuantityDefaults } from "./quantity-defaults";

/** Price at the end of a line, e.g. "$7.80", "S$ 12.50", "3,60", "-2.00". */
const PRICE_AT_END = /(-?)\s*(?:\bS\s*\$|\$)?\s*(\d{1,6}(?:,\d{3})*\s?[.,]\s?\d{2})\s*-?\s*[A-Z]?\s*[|/=_©]*\s*$/i;

/**
 * Per-item tax markers printed after a product name, e.g. "NAAN(GST*)", "(GST)", "(T)", "*".
 * OCR often renders "*" as "#", "+", "x", "¥" or "%". These mark the ITEM as taxable; they are not
 * tax lines, so they're stripped before the line is classified.
 */
const ITEM_TAX_MARKER = /\s*[([{]\s*(?:GST|BST|6ST|VAT|SR|T|ZR)\s*[*#+x×¥%&]*\s*[)\]}]?\s*$/i;

/**
 * Summary labels are matched against the WHOLE label (anchored), never as substrings, so product
 * names such as "BUTTER CHICKEN B.LESS" or "TAX-FREE COLA" are never misread as charges.
 */
const L = {
  subtotal: /^(?:sub\s*-?\s*total|subttl|sales\s*(?:amount|amt|total)|net\s*sales|nett?\s*sub\s*-?\s*total|food\s*total|total\s*before\s*(?:tax|gst))\s*$/i,
  service: /^(?:service(?:\s*charge|\s*chg)?|svc(?:\s*chg)?|s\/?c|svr\s*chg|sc)(?:\s*\(?\d{1,2}(?:\.\d{1,2})?\s*%\)?)?\s*$/i,
  tax: /^(?:(?:total\s*)?(?:gst|vat|tax)(?:\s*(?:amt|amount))?(?:\s*(?:incl(?:usive|uded|\.)?)(?:\s*(?:of\s*)?(?:gst|vat|tax))?)?|(?:incl(?:usive|uded|\.)?\s*(?:of\s*)?)(?:gst|vat|tax))(?:\s*\(?\d{1,2}(?:\.\d{1,2})?\s*%\)?)?\s*$/i,
  discount: /^(?:disc(?:ount)?|less|promo(?:tion)?\s*discount|voucher|member\s*disc(?:ount)?|coupon)(?:\s+\d+(?:[.,]\d+)?\s*%|\s*[:#-]\s*[\w-]+)?\s*$/i,
  discountSummary: /^(?:total\s*(?:saving[s]?|discount[s]?)|saving[s]?\s*total)$/i,
  payment: /^(?:cash|change|visa|master\s*card|mastercard|amex|nets|pay\s*now|paylah|grab\s*pay|card|credit|debit|paid|payment|tender(?:ed)?|balance(?!\s*due)|rounding|round\s*adj)/i,
  total: /^(?:grand\s*total|total(?:\s*(?:amount|amt|due|payable|sgd|s\$))?|nett?\s*(?:amount|total)|amount(?:\s*(?:due|payable))?|balance\s*due)\s*:?$/i,
  /** Count lines such as "Total QTY 10" — never a monetary total. */
  count: /^(?:total\s*)?(?:qty|quantity|items?|pax|no\.?\s*of\s*items)(?:\s+\d+)?\s*$/i,
  itemHeader: /\b(?:products?|items?|descriptions?|desc)\b.*\b(?:qty|quantity|total|amount|price|amt)\b/i,
  inclusiveNote: /\b(?:incl(?:usive|udes?|uded|\.)?)\b.*\b(?:gst|vat|tax)\b|\b(?:gst|vat|tax)\b.*\bincl(?:usive|uded|\.)?\b/i,
};

/** Header lines that are never the merchant name. */
const NOT_MERCHANT = /^(?:table|tbl|final\s*receipt|receipt|tax\s*invoice|invoice|bill|order|cashier|waiter|server|date|time|tel|phone|gst\s*reg|uen|copy|reprint|welcome|thank)/i;

export interface ParseResult {
  receipt: Receipt;
  warnings: string[];
}

function money(raw: string): number | null {
  const s = raw.replace(/\s/g, "").replace(/,(\d{2})$/, ".$1").replace(/,/g, "");
  return parseMoney(s);
}

/** A single explicit decimal on a split row; quantity remains unresolved. */
function uncertainAmountRow(line: string): number | null {
  const plain = /^[\s:[\]|/!Il]*(?:S?\$\s*)?(\d{1,6}(?:,\d{3})*[.,]\s?\d{2})\s*[A-Z]?\s*$/i.exec(line);
  // Trailing digits can be real quantity columns, so they remain ambiguous.
  return plain ? money(plain[1]!) : null;
}

/** Normalise a label for summary matching: drop leading OCR noise and trailing colons. */
function cleanLabel(label: string): string {
  return label.replace(/^[^A-Za-z0-9$]+/, "").replace(/[\s:.\-_|©]+$/, "").trim();
}

/** Correct a small set of quantity-heading confusions only inside a complete price table. */
function normaliseHeader(line: string): string {
  return /\b(?:unit|price)\b/i.test(line) && /\b(?:amount|amt|total)\b/i.test(line)
    ? line.replace(/\b(?:qiy|qly|aty|q1y|qtl)\b/gi, "Qty") : line;
}

function isItemHeader(line: string): boolean {
  const header = normaliseHeader(line);
  return L.itemHeader.test(header) || /\bunit(?:\s*price)?(?:\s*\([^)]*\))?\s+(?:qty|quantity)\b.*\b(?:amount|amt|total)\b/i.test(header);
}

const SUMMARY_WORDS = ["subtotal", "subttl", "sales", "amount", "amt", "total", "grand", "net", "nett", "due", "payable", "service", "charge", "chg", "gst", "vat", "tax", "incl", "included", "inclusive", "saving", "savings", "discount", "discounts", "disc", "voucher", "coupon", "payment", "tender", "cash", "change", "visa", "master", "mastercard", "nets", "paynow", "paylah", "credit", "debit", "paid", "qty", "quantity"];
const labelSkeleton = (word: string) => word.toLowerCase().replace(/[il1|]/g, "!").replace(/0/g, "o").replace(/5/g, "s");

/** Candidate-label words only: never edit amounts, descriptions or the retained source text. */
function normaliseSummaryLabel(label: string): string {
  const normalised = label.replace(/[A-Za-z01|5]+/g, (word) => SUMMARY_WORDS.find((known) => labelSkeleton(known) === labelSkeleton(word)) ?? word);
  const summary = /^(?:(?:\d+\s+)?(?:grand\s+)?total|sub\s*-?\s*total|sales\s+amount|net\b|nett\b|amount\b|balance\s+due|service\b|svc\b|s\/c\b|gst\b|vat\b|tax\b|incl\b|inclusive\b|discount\b|disc\b|voucher\b|coupon\b|total\s+savings?\b|savings?\s+total\b|visa\b|master(?:card)?\b|nets\b|pay\s*now\b|paylah\b|cash\b|change\b|credit\b|debit\b|payment\b|paid\b|tender\b)/i.test(normalised);
  return summary ? normalised : label;
}

/** Damaged tax notes can carry digits without forming a valid amount. Do not use
 * their following numeric debris as an item continuation. Product names merely
 * containing TAX/GST remain eligible unless financial-label context supports it. */
function isUnpricedFinancialNote(line: string): boolean {
  const label = normaliseSummaryLabel(cleanLabel(line));
  const taxContext = /^(?:(?:total\s+)?(?:gst|vat|tax)\b|(?:prices?|amounts?|total)\b.*\b(?:gst|vat|tax)\b)/i.test(label);
  const monetaryCue = /[%$£€¥]|\b(?:SGD|USD|MYR)\b/i.test(line);
  const numericSummary = /^(?:total\s*)?(?:gst|vat|tax)\s+(?:amt|amount|rate)\b/i.test(label) && /\d/.test(line);
  return taxContext && (monetaryCue || numericSummary);
}

/** Permit a single stray margin character only before a complete known summary label. */
function summaryLabel(label: string): string {
  label = normaliseSummaryLabel(label);
  // Separators and isolated currency marks belong to a financial label only when
  // removing them yields a complete recognised label. Retain the literal source.
  const financial = label.replace(/\s*[:;=]\s*$/, "").replace(/\s+(?:SGD|S\s*\$?|\$)\s*$/i, "").replace(/\s*[:;=]\s*$/, "").trim();
  if (L.tax.test(financial) || L.service.test(financial) || L.subtotal.test(financial) || L.discount.test(financial) || L.discountSummary.test(financial) || isTotal(financial)) label = financial;
  const candidate = label.replace(/^[A-Z0-9]\s+/i, "");
  return /^(?:GST|VAT|TAX)\s*(?:AMT|AMOUNT|\d+(?:\.\d+)?\s*%)?$/i.test(candidate)
    || L.discountSummary.test(candidate) || isTotal(candidate) ? candidate : label;
}

/** Retain a complete tax label with one isolated OCR margin token, with review.
 * This cannot match arbitrary tax-prefixed product descriptions. */
function taxLabelWithMargin(label: string): string | null {
  const match = /^(.*?)\s+[A-Za-z]\s*(?:\$)?\s*$/.exec(label);
  return match && L.tax.test(match[1]!.trim()) ? match[1]!.trim() : null;
}

/** Strip only recognised total qualifiers, not arbitrary words in product names. */
function isTotal(label: string): boolean {
  const core = label.replace(/^\d{1,3}\s+/, "")
    .replace(/[()]/g, " ")
    .replace(/\b(?:incl(?:usive|uded)?\.?\s*(?:of\s*)?(?:gst|vat|tax))\b/gi, " ")
    .replace(/\bSGD\b|S\$/gi, " ")
    .replace(/\s+/g, " ").trim();
  return L.total.test(core);
}

function isPayment(label: string): boolean {
  const payment = /^(cash|change|visa|master\s*card|mastercard|master|amex|nets|pay\s*now|paylah|grab\s*pay|card|credit|debit|paid|payment|tender(?:ed)?|balance(?!\s*due)|rounding|round\s*adj)(.*)$/i.exec(label);
  if (!payment) return false;
  return /^\s*(?:(?:contactless|debit|credit|card|tendered)|by\s+(?:visa|master\s*card|mastercard|nets|pay\s*now)|[:#-]?[x*\d][x*\d\s()[\]#/-]*)?\s*$/i.test(payment[2]!);
}

/** Literal summary evidence only; reused for corroboration across same-run OCR attempts. */
export function receiptSummaryEvidence(text: string) {
  const totals: { label: string; cents: number }[] = [];
  const payments: { label: string; cents: number }[] = [];
  let totalAmbiguous = false;
  let paymentAmbiguous = false;
  let paymentRows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (isReceiptRoundingLine(line)) continue;
    const m = PRICE_AT_END.exec(line);
    if (!m) continue;
    const cents = money(m[2]!);
    if (cents === null) continue;
    const literalLabel = cleanLabel(line.slice(0, m.index));
    const label = summaryLabel(cleanLabel(normaliseSummaryLabel(line.slice(0, m.index))));
    const network = /^(?:master(?:\s*card)?|visa|amex|nets|pay\s*now)(?=$|[\s:#-])(.*)$/i.exec(label);
    const electronic = network !== null
      && /^(?:\s*|\s*[:#-].*|\s+[x*\d][x*\d\s()[\]#/-]*)$/i.test(network[1]!)
      && !/\b(?:balance|limit|available|refund|change|cash|tender)\b/i.test(label);
    const paymentRow = isPayment(label) || electronic;
    if (paymentRow && ++paymentRows > 1) paymentAmbiguous = true;
    if (m[1] === "-" || /\d{2}\s*-\s*[A-Z]?\s*[|/=_©]*\s*$/i.test(line)) {
      if (isTotal(label)) totalAmbiguous = true;
      if (paymentRow) paymentAmbiguous = true;
      continue;
    }
    if (isTotal(label)) totals.push({ label: literalLabel, cents });
    else if (electronic) payments.push({ label: literalLabel, cents });
    else if (isPayment(label)) paymentAmbiguous = true;
  }
  return { totals, payments, totalAmbiguous, paymentAmbiguous, ambiguous: totalAmbiguous || paymentAmbiguous };
}

function isWordy(l: string): boolean {
  const letters = (l.match(/[a-z]/gi) ?? []).length;
  return letters >= 3 && letters / l.replace(/\s/g, "").length > 0.6;
}

interface ItemSplit { desc: string; quantity: number; quantityObserved: boolean; quantityExact: RationalQuantity | null; qtyUncertain: boolean; taxMarked: boolean }

/** Separates description, item tax marker and a leading OR trailing quantity column. */
export function splitItemLabel(label: string, quantityColumn: "auto" | "none" = "auto", allowBareLeading = false, allowBareTrailing = false): ItemSplit {
  let desc = label.trim();
  let quantity = 1;
  let quantityObserved = false;
  let quantityExact: RationalQuantity | null = null;
  let qtyUncertain = true;
  const explicitLead = /^(\d{1,3}(?:\.\d{1,6})?|\d{1,3}\/\d{1,6})\s*[x×*]\s*(.+)$/i.exec(desc);
  const bareLead = allowBareLeading ? /^(\d{1,3}(?:\.\d{1,6})?|\d{1,3}\/\d{1,6})\s+(.+)$/i.exec(desc) : null;
  const identifierAtEnd = /\b(?:no\.?|model|id|code|sku)\s+\d+\s*$/i.test(desc);
  // A trailing number can be a product identifier. Only a supported trailing
  // quantity heading establishes its role; a numeric suffix alone cannot.
  // Within that column OCR may read "1" as I, l, | or ! (still unresolved).
  const trail = quantityColumn === "auto" && allowBareTrailing && !explicitLead && !bareLead && !identifierAtEnd ? /^(.*?[A-Za-z0-9)\]*#+])\s+(\d{1,3}(?:\.\d{1,6})?|\d{1,3}\/\d{1,6}|[Il|!])$/.exec(desc) : null;
  if (trail) {
    const raw = trail[2] ?? "1";
    quantityExact = /\d/.test(raw) ? parseQuantity(raw) : null;
    quantity = quantityExact ? quantityNumber(quantityExact) : 1;
    quantityObserved = quantityExact !== null;
    qtyUncertain = !quantityObserved;
    desc = trail[1] ?? desc;
  } else if (quantityColumn === "auto" && !/^\d+\s*[.-]?\s*FOR\b/i.test(desc)) {
    // A bare leading number can be part of a product name. Only a quantity
    // heading or an explicit multiplication token establishes its column role.
    const lead = explicitLead ?? bareLead;
    if (lead) {
      const exact = parseQuantity(lead[1]!);
      if (exact && exact.numerator > 0) { quantityExact = exact; quantity = quantityNumber(exact); quantityObserved = true; qtyUncertain = false; desc = lead[2] ?? desc; }
    }
  }
  if (quantity <= 0) { quantity = 1; quantityExact = null; quantityObserved = false; qtyUncertain = true; }
  // Drop a trailing unit price ("Coffee 2 @ 3.50") — we keep only the line total.
  desc = desc.replace(/\s*@\s*\$?\d+[.,]\d{2}\s*$/, "");
  let taxMarked = false;
  if (ITEM_TAX_MARKER.test(desc)) { taxMarked = true; desc = desc.replace(ITEM_TAX_MARKER, ""); }
  desc = desc.replace(/[^\p{L}\p{N}&'()./+\- ]/gu, "").replace(/\s+/g, " ").trim();
  return { desc, quantity, quantityObserved, quantityExact, qtyUncertain, taxMarked };
}

function fieldEvidence(origin: ValueOrigin, sources: SourceEvidence[], reasons: string[] = []): FieldEvidence {
  return { origin, sources, needsReview: reasons.length > 0 || origin === "unknown" || origin === "defaulted" || origin === "inferred", reasons };
}

type Section = "header" | "items" | "summary";

/** Pure parser: turns raw OCR text into a draft receipt. Never invents prices. */
export function parseReceiptText(text: string): ParseResult {
  const r = emptyReceipt();
  r.rawOcrText = text;
  const warnings: string[] = [];
  const uncertain = new Set<string>();
  const indexedLines = text.split(/\r?\n/).map((raw, index) => ({ index, text: raw.replace(/\s+/g, " ").trim() })).filter((line) => line.text);
  const lines = indexedLines.map((line) => line.text);
  const source = (indices: number[]): SourceEvidence[] => indices.map((index) => ({ kind: "text", engine: "text", lineIndices: [indexedLines[index]!.index], text: lines[index]! }));
  r.rows = indexedLines.map((line, index) => ({ id: `row-${line.index}`, role: "heading", text: line.text, amountCents: null, sources: source([index]), needsReview: false }));
  const markRows = (indices: number[], role: ReceiptRowEvidence["role"], amountCents: number | null, needsReview = false) => {
    for (const index of indices) Object.assign(r.rows![index]!, { role, amountCents, needsReview });
  };
  const receiptSources: { merchant: SourceEvidence[]; total: SourceEvidence[]; discount: SourceEvidence[]; service: SourceEvidence[]; gst: SourceEvidence[]; inclusive: SourceEvidence[] } = { merchant: [], total: [], discount: [], service: [], gst: [], inclusive: [] };
  const hasItemHeader = lines.some((l) => isItemHeader(l) && !PRICE_AT_END.test(l));

  // Merchant: first wordy, unpriced line in the top section that isn't a known heading.
  for (const l of lines.slice(0, 8)) {
    if (PRICE_AT_END.test(l) || isItemHeader(l)) break;
    const c = cleanLabel(l);
    if (NOT_MERCHANT.test(c) || !isWordy(c)) continue;
    r.merchant = c.slice(0, 60);
    receiptSources.merchant = source([lines.indexOf(l)]);
    break;
  }
  if (!r.merchant) uncertain.add("merchant");

  let serviceAmt: number | null = null;
  let taxAmt: number | null = null;
  let discountSummary: number | null = null;
  let discountAdjustmentSeen = false;
  let serviceRateObserved = false;
  let gstRateObserved = false;
  let signedServiceUnknown = false;
  let signedGstUnknown = false;
  let taxLabelUncertain = false;
  let discountRoleInferred = false;
  let totalConflict = false;
  const payments: { label: string; amount: number; negative: boolean; index: number }[] = [];
  let anyTaxMarked = false;
  const items: ReceiptItem[] = [];
  const skipped: string[] = [];
  let section: Section = hasItemHeader ? "header" : "items";
  let unitBeforeQuantity = false;
  let separateUnitPrice = false;
  let quantityBeforeUnit = false;
  let columnHeaderIndex: number | null = null;
  let quantityUnit: string | null = null;
  let priceUnit: string | null = null;
  let quantityColumnKnown = false;
  let quantityLeadingColumnKnown = false;
  let quantityTrailingColumnKnown = false;

  const addItem = (item: ReceiptItem, split: ItemSplit | null, indices: number[], unitPriceCents: number | null = null, rowKind: ReceiptItem["rowKind"] = "product") => {
    const sources = source(indices);
    const observedQuantity = !!split?.quantityObserved;
    item.quantityExact = observedQuantity ? split?.quantityExact ?? { numerator: item.quantity, denominator: 1 } : null;
    item.unitPriceCents = unitPriceCents;
    item.rowKind = rowKind;
    if (quantityUnit) item.unitOfMeasure = quantityUnit;
    if (unitPriceCents !== null && columnHeaderIndex !== null) {
      // A unit-price heading establishes which two numeric columns belong to this row.
      // Explicit measurement units are retained; mixed/unrecognised units are reviewed.
      item.unitOfMeasure = quantityUnit ?? "each";
      item.priceBasis = { quantity: { numerator: 1, denominator: 1 }, unit: priceUnit ?? "each" };
    }
    item.evidence = {
      description: fieldEvidence("observed", sources, /[|{}[\]]/.test(sources.map((s) => s.text).join(" ")) || item.description.replace(/[^A-Za-z]/g, "").length < 4 ? ["The product description contains uncertain recognition."] : []),
      quantity: fieldEvidence(observedQuantity ? "observed" : "unknown", sources, !observedQuantity ? ["Quantity was not identified; the displayed 1 is a compatibility placeholder, not a confirmed quantity."] : split?.qtyUncertain ? ["The observed quantity or its price columns need checking."] : []),
      unitPriceCents: fieldEvidence(unitPriceCents === null ? "unknown" : "observed", sources),
      lineTotalCents: fieldEvidence(item.lineTotalCents === null ? "unknown" : "observed", sources, item.lineTotalCents === null ? ["The full line amount could not be identified."] : []),
      role: fieldEvidence(rowKind === "ambiguous" ? "unknown" : "observed", sources, rowKind === "ambiguous" ? ["A signed row could be a return or adjustment; its role must be confirmed."] : []),
    };
    if (unitPriceCents !== null && columnHeaderIndex !== null) item.evidence.pricingBasis = fieldEvidence("observed", source([columnHeaderIndex]), quantityUnit && !priceUnit ? ["The quantity has a measurement unit but the unit-price basis is not explicit."] : []);
    const relationshipReasons = validatePriceRelationship(item);
    if (relationshipReasons.length) {
      for (const key of ["quantity", "unitPriceCents", "lineTotalCents"] as const) {
        item.evidence[key]!.needsReview = true;
        item.evidence[key]!.reasons.push(...relationshipReasons);
      }
    }
    const requiredFieldReview = (["description", "quantity", "lineTotalCents", "role", "pricingBasis"] as const).some((field) => item.evidence?.[field]?.needsReview);
    const assertedUnitPriceReview = unitPriceCents !== null && item.evidence.unitPriceCents?.needsReview;
    if (!observedQuantity || relationshipReasons.length || requiredFieldReview || assertedUnitPriceReview) {
      item.flagged = true;
      uncertain.add("items");
    }
    // Quantity/amount uncertainty does not by itself make a known product's
    // row role uncertain a second time; its field warning remains visible.
    markRows(indices, "product", item.lineTotalCents, rowKind === "ambiguous" || item.evidence.description!.needsReview);
    items.push(item);
  };

  for (let index = 0; index < lines.length; index++) {
    const firstIndex = index;
    let joinedQuantity: string | null = null;
    let joinedDescription: string | null = null;
    let line = lines[index]!;
    if (isReceiptRoundingLine(line)) { markRows([index], "rounding", null); continue; }
    if (L.inclusiveNote.test(line) && !PRICE_AT_END.test(line)) { r.gstInclusive = true; receiptSources.inclusive.push(...source([index])); }
    if (isItemHeader(line) && !PRICE_AT_END.test(line)) {
      const header = normaliseHeader(line);
      separateUnitPrice = /\bunit\b/i.test(header)
        || (/\bprice\b/i.test(header) && /\b(?:amount|amt|total)\b/i.test(header));
      unitBeforeQuantity = /\bunit(?:\s*price)?\b.*\b(?:qty|quantity)\b/i.test(header)
        || /\bprice\b.*\b(?:qty|quantity)\b.*\b(?:amount|amt|total)\b/i.test(header);
      quantityBeforeUnit = separateUnitPrice && /\b(?:qty|quantity)\b.*\b(?:unit|price)\b.*\b(?:amount|amt|total)\b/i.test(header);
      quantityColumnKnown = /\b(?:qty|quantity)\b/i.test(header);
      quantityLeadingColumnKnown = /^\s*(?:qty|quantity)\b/i.test(header);
      quantityTrailingColumnKnown = quantityColumnKnown && !quantityLeadingColumnKnown;
      columnHeaderIndex = separateUnitPrice ? index : null;
      quantityUnit = /\b(?:qty|quantity|weight)\s*\(\s*(kg|g|ml|l|ea|each|pcs|pieces?)\s*\)/i.exec(header)?.[1]?.toLowerCase() ?? null;
      priceUnit = /\b(?:unit|price)(?:\s*price)?\s*\([^)]*\/\s*(kg|g|ml|l|ea|each|pcs|pieces?)\s*\)/i.exec(header)?.[1]?.toLowerCase() ?? null;
      markRows([index], "heading", null);
      section = "items";
      continue;
    }
    if (!PRICE_AT_END.test(line) && isUnpricedFinancialNote(line)) {
      markRows([index], "ambiguous", null, true);
      const next = lines[index + 1];
      if (next && /^[\d\s:[\]|/]/.test(next) && /\d/.test(next) && (next.match(/[A-Za-z]/g) ?? []).length <= 3) markRows([index + 1], "ambiguous", null, true);
      uncertain.add("charges");
      warnings.push("A damaged tax/financial note was retained for review. Its following numeric fragments were not attached to a product.");
      continue;
    }

    // Some receipts put a description above a row containing only quantity and line amount.
    // Join adjacent rows only with this explicit numeric shape; never borrow summary amounts.
    if (section === "items" && !PRICE_AT_END.test(line)) {
      const label = cleanLabel(line);
      const next = lines[index + 1];
      const uncertainAmount = next && !separateUnitPrice ? uncertainAmountRow(next) : null;
      const continuation = next && /^(\d{1,3}(?:\.\d{1,6})?|\d{1,3}\/\d{1,6})\s+(S?\$?\s*\d{1,6}(?:,\d{3})*[.,]\d{2}\s*[A-Z]?)$/i.exec(next);
      const candidateDescription = /[A-Za-z]{2}/.test(label) && label !== r.merchant && !NOT_MERCHANT.test(label)
        && !isTotal(label) && !isPayment(label) && !L.subtotal.test(label) && !L.tax.test(label)
        && !L.service.test(label) && !L.discount.test(label) && !L.discountSummary.test(label)
        && !L.count.test(label) && !L.inclusiveNote.test(label);
      if (continuation && candidateDescription) {
        joinedQuantity = continuation[1]!;
        joinedDescription = line;
        line = `${continuation[1]} ${line} ${continuation[2]}`;
        index++;
      } else if (candidateDescription && uncertainAmount !== null) {
        // A single explicit decimal amount survives even when its quantity column does
        // not. Never invent a quantity, repair cents, or treat a lone unit price as a line
        // total. The model's required quantity=1 is a review placeholder, not a verified 1.
        const s = splitItemLabel(label, "none");
        addItem({ id: newId("i"), description: s.desc.slice(0, 80), quantity: 1, lineTotalCents: uncertainAmount, flagged: true }, null, [index, index + 1]);
        if (s.taxMarked) anyTaxMarked = true;
        uncertain.add("items");
        warnings.push("An item has a readable line amount but an unreadable quantity. Confirm its quantity.");
        index++;
        continue;
      } else if (candidateDescription && next && /^[\d\s:[\]|/]/.test(next) && /\d/.test(next)
        && (next.match(/[A-Za-z]/g) ?? []).length <= 3 && !/\bFOR\b/i.test(next)) {
        // A recognisable product followed by damaged numeric columns is still an item.
        // Keep its price unknown rather than mining stray digits or borrowing a later total.
        const s = splitItemLabel(label, "none");
        addItem({ id: newId("i"), description: s.desc.slice(0, 80), quantity: 1, lineTotalCents: null, flagged: true }, null, [index, index + 1]);
        uncertain.add("items");
        warnings.push("An item has unreadable quantity/price columns. Confirm its quantity and line amount.");
        index++;
        continue;
      }
    }

    const m = PRICE_AT_END.exec(line);
    const rawLabel = m ? line.slice(0, m.index).trim() : line;
    const productLabel = cleanLabel(rawLabel);
    const label = summaryLabel(cleanLabel(normaliseSummaryLabel(rawLabel)));

    if (L.count.test(label)) { markRows([index], "summary", null); continue; } // A count, never money.

    if (!m) {
      // An explicit unit/quantity/amount heading can survive while its final amount
      // becomes non-numeric. Retain the descriptor without guessing any numeric field.
      const damagedUnitRow = section === "items" && unitBeforeQuantity
        ? /^(.*?[A-Za-z)])\s+S?\$?\s*\d+[.,]\d{2}\s+\S.*$/.exec(line) : null;
      if (damagedUnitRow) {
        const label = cleanLabel(damagedUnitRow[1]!);
        if (!isTotal(label) && !isPayment(label) && !L.subtotal.test(label) && !L.service.test(label) && !L.tax.test(label) && !L.discount.test(label)) {
          addItem({ id: newId("i"), description: label.slice(0, 80), quantity: 1, lineTotalCents: null, flagged: true }, null, [index]);
          uncertain.add("items");
          warnings.push("An item has damaged unit-price, quantity or amount columns. Confirm its highlighted values.");
          continue;
        }
      }
      // Item-section lines that lost their price: keep them (flagged) instead of dropping silently.
      if (section === "items" && hasItemHeader && !/^[-=_.\s]+$/.test(line)) {
        const s = splitItemLabel(productLabel, "auto", quantityLeadingColumnKnown, quantityTrailingColumnKnown);
        const letters = (s.desc.match(/\p{L}/gu) ?? []).length;
        if (letters >= 3 && (s.taxMarked || /\s\d{1,2}$/.test(label))) {
          if (s.taxMarked) anyTaxMarked = true;
          addItem({ id: newId("i"), description: s.desc.slice(0, 80), quantity: s.quantity, lineTotalCents: null, flagged: true }, s, [index]);
        } else if (letters >= 3 && label !== r.merchant && !NOT_MERCHANT.test(label) && !L.inclusiveNote.test(label) && !isTotal(label) && !isPayment(label) && !L.subtotal.test(label) && !L.tax.test(label) && !L.service.test(label)) {
          markRows([index], "ambiguous", null, true);
        }
      }
      continue;
    }

    const amount = money(m[2] ?? "");
    if (amount === null) { skipped.push(line); continue; }
    const negative = m[1] === "-" || /\d{2}\s*-\s*[A-Z]?\s*[|/=_©]*\s*$/i.test(line);
    if (/^\d+\s*[.-]?\s*FOR\s+S?\$?\s*\d+[.,]\d{2}\s*$/i.test(line)) { markRows([index], "heading", null); continue; }

    if (L.subtotal.test(label)) { r.printedSubtotalCents = amount; markRows([index], "summary", amount); section = "summary"; continue; }
    if (L.service.test(label)) {
      markRows([index], "adjustment", negative ? -amount : amount, negative);
      receiptSources.service.push(...source([index]));
      if (negative) { signedServiceUnknown = true; uncertain.add("charges"); section = "summary"; warnings.push("A signed service-charge amount requires confirmation; it was not converted into a positive charge."); continue; }
      serviceAmt = amount; section = "summary";
      const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
      if (rate) { const bp = parseRate(rate[1] ?? ""); if (bp !== null) { r.serviceRateBp = bp; serviceRateObserved = true; } }
      continue;
    }
    const uncertainTaxLabel = taxLabelWithMargin(label);
    if ((L.tax.test(label) || uncertainTaxLabel !== null) && !ITEM_TAX_MARKER.test(label)) {
      markRows([index], "summary", negative ? -amount : amount, negative);
      receiptSources.gst.push(...source([index]));
      if (negative) { signedGstUnknown = true; uncertain.add("charges"); section = "summary"; warnings.push("A signed GST amount requires confirmation; it was not converted into a positive charge."); continue; }
      taxAmt = amount; section = "summary";
      if (uncertainTaxLabel !== null) { taxLabelUncertain = true; uncertain.add("charges"); warnings.push("A tax amount has a complete label plus an uncertain margin token. Confirm the tax field and treatment."); }
      if (L.inclusiveNote.test(label)) { r.gstInclusive = true; receiptSources.inclusive.push(...source([index])); }
      const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
      if (rate) { const bp = parseRate(rate[1] ?? ""); if (bp !== null) { r.gstRateBp = bp; gstRateObserved = true; } }
      continue;
    }
    if (isPayment(label)) { payments.push({ label, amount, negative, index }); markRows([index], "payment", negative ? -amount : amount); section = "summary"; continue; }
    if (L.discountSummary.test(label)) {
      markRows([index], "summary", amount);
      receiptSources.discount.push(...source([index]));
      if (discountSummary !== null && discountSummary !== amount) {
        uncertain.add("discount");
        warnings.push("Printed discount summaries disagree. Check the discount amount.");
      }
      discountSummary = amount;
      section = "summary";
      continue;
    }
    const promotion = /^(\d+)\s*[.-]?\s*FOR\s+S?\$?\s*(\d+[.,]\d{2})$/i.exec(productLabel);
    if (L.discount.test(label)) { r.discountCents += amount; discountAdjustmentSeen = true; receiptSources.discount.push(...source([index])); markRows([index], "adjustment", -amount); continue; }
    if (promotion) {
      const previous = items[items.length - 1];
      const previousRow = r.rows![Math.max(0, index - 1)]!;
      // A bare offer is not a purchased row or a discount. A separately signed offer
      // adjustment is interpretable only with a matching adjacent purchased quantity
      // and independently printed full-line/offer amounts. No payable total is used.
      const supportedAdjustment = negative && previousRow.role === "product" && previous?.quantityExact?.denominator === 1
        && previous.quantityExact.numerator === Number(promotion[1]) && previous.lineTotalCents !== null
        && previous.lineTotalCents - money(promotion[2]!)! === amount;
      if (supportedAdjustment) {
        r.discountCents += amount;
        discountAdjustmentSeen = true;
        discountRoleInferred = true;
        receiptSources.discount.push(...source([index - 1, index]));
        markRows([index], "adjustment", -amount, true);
        uncertain.add("discount");
        warnings.push("A signed offer adjustment matches the adjacent product, but its discount role still needs confirmation.");
      } else {
        markRows([index], "ambiguous", negative ? -amount : amount, negative);
        if (negative) { uncertain.add("discount"); warnings.push("A signed promotional row has an unresolved financial role; it was not deducted automatically."); }
      }
      continue;
    }
    if (isTotal(label)) {
      markRows([index], "summary", negative ? -amount : amount, negative);
      receiptSources.total.push(...source([index]));
      if (negative) { totalConflict = true; uncertain.add("total"); }
      else if (r.receiptTotalCents === null) r.receiptTotalCents = amount;
      else if (r.receiptTotalCents !== amount) { totalConflict = true; uncertain.add("total"); warnings.push("Printed payable-total readings disagree. Confirm the total; no value was changed to reconcile them."); }
      if (L.inclusiveNote.test(label)) { r.gstInclusive = true; receiptSources.inclusive.push(...source([index])); }
      section = "summary";
      continue;
    }

    const explicitReturn = negative && /^(?:return(?:ed)?|refund)\s+\S/i.test(productLabel);
    const itemLabel = explicitReturn ? productLabel.replace(/^(?:return(?:ed)?|refund)\s+/i, "") : productLabel;
    const quantityPattern = "(?:\\d{1,3}(?:\\.\\d{1,6})?|\\d{1,3}\\/\\d{1,6})";
    // Explicit "N @ unit price" identifies those two fields even without a
    // table heading. A second, independently printed amount is required for
    // the full line amount: never copy the unit price or multiply to fill it.
    const atPrice = !negative ? /^(.*?)\s*@\s*(?:S\s*\$|\$)?\s*(\d+[.,]\d{2})(?:\s+(?:S\s*\$|\$)?\s*(\d+[.,]\d{2}))?\s*[A-Z]?\s*$/i.exec(line) : null;
    if (atPrice && (atPrice[1]!.match(/\p{L}/gu) ?? []).length >= 2) {
      const atQuantity = new RegExp(`^(.*?)\\s+(${quantityPattern})$`).exec(atPrice[1]!);
      const exact = atQuantity ? parseQuantity(atQuantity[2]!) : null;
      const leadingSplit = splitItemLabel(atPrice[1]!, "auto", quantityLeadingColumnKnown);
      const split = leadingSplit.quantityObserved ? leadingSplit : exact && exact.numerator > 0 ? splitItemLabel(atQuantity![1]!, "none")
        : splitItemLabel(atPrice[1]!, "auto", quantityLeadingColumnKnown, quantityTrailingColumnKnown);
      if (!leadingSplit.quantityObserved && exact && exact.numerator > 0)
        Object.assign(split, { quantity: quantityNumber(exact), quantityExact: exact, quantityObserved: true, qtyUncertain: false });
      if (split.taxMarked) anyTaxMarked = true;
      addItem({ id: newId("i"), description: split.desc.slice(0, 80), quantity: split.quantity,
        lineTotalCents: atPrice[3] ? money(atPrice[3]) : null, flagged: !atPrice[3] }, split, [index], money(atPrice[2]!));
      continue;
    }
    const unitThenQty = unitBeforeQuantity ? new RegExp(`^(.*?)\\s+S?\\$?\\s*(\\d+[.,]\\d{2})\\s+(${quantityPattern}|[?Il|!])$`).exec(itemLabel) : null;
    const qtyThenUnit = quantityBeforeUnit ? new RegExp(`^(.*?)\\s+(${quantityPattern}|[?Il|!])\\s+S?\\$?\\s*(\\d+[.,]\\d{2})$`).exec(itemLabel) : null;
    const columns = unitThenQty ? { desc: unitThenQty[1]!, unit: unitThenQty[2]!, qty: unitThenQty[3]! }
      : qtyThenUnit ? { desc: qtyThenUnit[1]!, unit: qtyThenUnit[3]!, qty: qtyThenUnit[2]! } : null;
    const missingQuantity = separateUnitPrice && !columns ? /^(.*?)\s+S?\$?\s*(\d+[.,]\d{2})$/.exec(itemLabel) : null;
    const damagedColumns = unitBeforeQuantity && !columns && !missingQuantity ? /^(.*?)\s+\d[\d\s.,]*$/.exec(itemLabel) : null;
    const s = columns ? splitItemLabel(columns.desc, "none") : missingQuantity ? splitItemLabel(missingQuantity[1]!, "none") : joinedDescription ? splitItemLabel(joinedDescription, "none") : splitItemLabel(damagedColumns?.[1] ?? itemLabel, "auto", quantityLeadingColumnKnown, quantityTrailingColumnKnown);
    if (columns) {
      const exact = parseQuantity(columns.qty);
      if (exact && exact.numerator > 0) { s.quantity = quantityNumber(exact); s.quantityExact = exact; s.quantityObserved = true; s.qtyUncertain = false; }
    }
    if (joinedQuantity) {
      const exact = parseQuantity(joinedQuantity);
      if (exact && exact.numerator > 0) { s.quantity = quantityNumber(exact); s.quantityExact = exact; s.quantityObserved = true; s.qtyUncertain = false; }
    }
    if (!quantityColumnKnown && !columns && !joinedQuantity && !/^\d+(?:\.\d+|\/\d+)?\s*[x×*]/i.test(itemLabel) && /\b(?:no\.?|model|id|code|sku)\s+\d+\s*$/i.test(itemLabel)) {
      const leading = /^(\d{1,3})\s+(.+)$/.exec(itemLabel);
      const description = splitItemLabel(itemLabel, "none");
      Object.assign(s, description);
      if (leading && quantityColumnKnown) { s.quantity = Number(leading[1]); s.quantityExact = { numerator: s.quantity, denominator: 1 }; s.quantityObserved = true; s.qtyUncertain = false; }
    }
    // A later product with a supported quantity/column shape remains recoverable after
    // a summary. Unknown priced rows remain inspectable rather than becoming products.
    if (section === "summary" && !columns && !s.quantityObserved && !s.taxMarked) { markRows([index], "ambiguous", negative ? -amount : amount, true); skipped.push(line); continue; }
    if (damagedColumns) {
      s.qtyUncertain = true;
      uncertain.add("items");
      warnings.push("Unit-price/quantity columns are unreadable. Confirm the highlighted item's quantity.");
    }
    if (negative && !explicitReturn) {
      uncertain.add("discount");
      warnings.push("A minus sign on an item is ambiguous. Confirm its line amount and whether it is a discount or return; no discount was inferred.");
    }
    // Keep the printed line amount even when unit price x quantity disagrees (offers may apply).
    const letters = (s.desc.match(/\p{L}/gu) ?? []).length;
    if (letters < 2) { skipped.push(line); continue; }
    if (s.taxMarked) anyTaxMarked = true;
    const flagged = negative && !explicitReturn || s.qtyUncertain || letters < 4 || /[|{}[\]]/.test(line);
    addItem({ id: newId("i"), description: s.desc.slice(0, 80), quantity: s.quantity, lineTotalCents: explicitReturn ? -amount : negative ? null : amount, flagged }, s, index === firstIndex ? [index] : [firstIndex, index], columns ? money(columns.unit) : missingQuantity ? money(missingQuantity[2]!) : null, explicitReturn ? "return" : negative ? "ambiguous" : "product");
  }

  if (discountSummary !== null) {
    if (discountAdjustmentSeen && r.discountCents !== discountSummary) {
      uncertain.add("discount");
      warnings.push(`Discount lines add up to ${fmt(r.discountCents)} but the savings summary is ${fmt(discountSummary)}. Check the discount; the summary was not deducted again.`);
    }
  }
  if (signedServiceUnknown) serviceAmt = null;
  if (signedGstUnknown) taxAmt = null;
  const unresolvedAdjustment = r.rows!.some((row) => row.role === "ambiguous" && row.needsReview) || discountSummary !== null || discountAdjustmentSeen;
  const mixedTaxBasis = lines.some((line) => /\bunit\b.*\bexcl/i.test(line)) && lines.some((line) => /\b(?:amount|total)\b.*\bincl/i.test(line))
    || lines.some((line) => /\bunit\b.*\bincl/i.test(line)) && lines.some((line) => /\b(?:amount|total)\b.*\bexcl/i.test(line));
  for (const item of items) {
    if (mixedTaxBasis && item.unitPriceCents !== null && item.unitPriceCents !== undefined) {
      item.pricingContext = { discounts: unresolvedAdjustment ? "unresolved" : "none", tax: "unresolved", adjustment: "none" };
      item.evidence!.pricingBasis = fieldEvidence("unknown", item.evidence!.pricingBasis?.sources ?? [], ["Unit price and full line amount have conflicting tax-basis labels; confirm their relationship."]);
      item.flagged = true;
      uncertain.add("items");
    }
    if (item.quantityExact !== null || !item.unitPriceCents || item.lineTotalCents === null || item.lineTotalCents <= 0 || item.unitPriceCents <= 0 || item.rowKind !== "product" || unresolvedAdjustment || mixedTaxBasis || !item.priceBasis || item.unitOfMeasure !== item.priceBasis.unit || item.evidence?.pricingBasis?.needsReview) continue;
    if (item.lineTotalCents % item.unitPriceCents !== 0) continue;
    const suggestion = item.lineTotalCents / item.unitPriceCents;
    if (!Number.isSafeInteger(suggestion) || suggestion < 1 || suggestion > 9999) continue;
    item.quantity = suggestion;
    item.quantityExact = { numerator: suggestion, denominator: 1 };
    item.evidence!.quantity = fieldEvidence("inferred", [...item.evidence!.unitPriceCents!.sources, ...item.evidence!.lineTotalCents!.sources, ...item.evidence!.pricingBasis!.sources, { kind: "calculation", text: "Full line amount / independently identified unit price; exact integer division on the same pricing basis." }], ["Quantity auto-filled, please check. Exact price division is a suggestion, not proof of the purchased quantity."]);
    item.flagged = true;
    uncertain.add("items");
    warnings.push("A missing quantity was auto-filled from its identified unit price and full line amount. Please check it.");
  }
  r.items = items;
  Object.assign(r, applyReceiptRounding(r, text));
  if (r.evidence?.rounding?.needsReview) uncertain.add("rounding");
  warnings.push(...(r.evidence?.rounding?.reasons ?? []));
  if (items.length === 0) warnings.push("No purchased items were recognised. Add them manually.");
  const missing = items.filter((i) => i.lineTotalCents === null).length;
  if (missing) warnings.push(`${missing} item line(s) were read without a price — enter the line total for highlighted items.`);
  if (items.some((i) => i.flagged && i.lineTotalCents !== null)) warnings.push("Some item lines look uncertain — please check highlighted lines.");
  if (skipped.length) warnings.push(`Lines not used: ${skipped.slice(0, 4).map((s) => `“${s.slice(0, 40)}”`).join(", ")}${skipped.length > 4 ? "…" : ""}`);

  const sum = items.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  reconcileCharges(r, { sum, serviceAmt, taxAmt, anyTaxMarked, complete: missing === 0 }, warnings, uncertain);

  const arithmeticTaxMode = taxAmt !== null && (receiptSources.inclusive.length === 0 || !r.gstInclusive);
  const summaryOnlyDiscount = discountSummary !== null && !discountAdjustmentSeen;
  if (summaryOnlyDiscount) { uncertain.add("discount"); warnings.push("The savings summary is informational. It was not deducted again; confirm any separate discount adjustment."); }
  const currencyCodes = indexedLines.filter((line) => /\b(?:SGD|USD|MYR|EUR|GBP|AUD|CNY|JPY|HKD|THB|INR)\b/i.test(line.text));
  const unsupportedCurrency = currencyCodes.some((line) => /\b(?:USD|MYR|EUR|GBP|AUD|CNY|JPY|HKD|THB|INR)\b/i.test(line.text));
  const observedSgd = !unsupportedCurrency && currencyCodes.some((line) => /^(?:currency\s*[:=]?\s*)?SGD\s*$/i.test(line.text) || /\bSGD\b.*\d+[.,]\d{2}|\d+[.,]\d{2}\s*SGD\b/i.test(line.text));
  if (unsupportedCurrency) { uncertain.add("currency"); warnings.push("A currency other than supported SGD was recognised. Confirm or convert the currency before splitting; SGD remains only the application preference."); }
  const summaryEvidence = receiptSummaryEvidence(text);
  const tenderSuggestion = r.receiptTotalCents === null && !totalConflict && payments.length === 1 && !payments[0]!.negative && summaryEvidence.payments.length === 1 && !summaryEvidence.ambiguous
    ? summaryEvidence.payments[0]!.cents : null;
  r.suggestedTotalCents = tenderSuggestion;
  if (tenderSuggestion !== null) { uncertain.add("total"); warnings.push("A single electronic payment provides a suggested total only. It is not a printed payable total; confirm it against the receipt."); }
  r.evidence = {
    ...(r.evidence?.rounding ? { rounding: r.evidence.rounding } : {}),
    currency: fieldEvidence(observedSgd ? "observed" : "defaulted", currencyCodes.map((line) => ({ kind: "text", engine: "text", lineIndices: [line.index], text: line.text })), unsupportedCurrency ? ["A different currency code was observed; this application supports SGD only. Confirm conversion before splitting."] : observedSgd ? [] : ["SGD is the application preference; receipt currency has not been confirmed."]),
    merchant: fieldEvidence(r.merchant ? "observed" : "unknown", receiptSources.merchant, r.merchant ? [] : ["Merchant was not identified."]),
    discountCents: fieldEvidence(discountRoleInferred ? "inferred" : discountAdjustmentSeen ? "observed" : "unknown", receiptSources.discount, summaryOnlyDiscount ? ["A savings summary does not establish an additional discount; no adjustment was deducted."] : discountAdjustmentSeen ? uncertain.has("discount") ? ["Discount evidence conflicts or its role is ambiguous."] : [] : ["No discount information was identified; zero is a calculation default, not confirmed absence."]),
    service: fieldEvidence(serviceAmt === null ? "unknown" : "observed", receiptSources.service, signedServiceUnknown ? ["A signed service-charge amount was retained as evidence but its treatment is unresolved."] : serviceAmt === null ? ["No service-charge amount was identified; absence is not a confirmed zero charge."] : []),
    serviceRateBp: fieldEvidence(serviceRateObserved ? "observed" : "defaulted", serviceRateObserved ? receiptSources.service : [], serviceRateObserved || !r.serviceEnabled || r.chargeMode === "receipt" ? [] : ["The service-charge rate is an application preference, not an observed receipt rate."]),
    gst: fieldEvidence(taxAmt === null ? "unknown" : "observed", receiptSources.gst, signedGstUnknown ? ["A signed GST amount was retained as evidence but its treatment is unresolved."] : taxLabelUncertain ? ["The tax label contains an uncertain isolated margin token; confirm this amount's role."] : taxAmt === null ? ["No GST amount was identified; absence is not a confirmed zero charge."] : []),
    gstRateBp: fieldEvidence(gstRateObserved ? "observed" : "defaulted", gstRateObserved ? receiptSources.gst : [], gstRateObserved || !r.gstEnabled || r.chargeMode === "receipt" ? [] : ["The GST rate is an application preference, not an observed receipt rate."]),
    gstInclusive: fieldEvidence(arithmeticTaxMode ? "inferred" : receiptSources.inclusive.length ? "observed" : "unknown", arithmeticTaxMode ? [...receiptSources.inclusive, ...receiptSources.gst, ...receiptSources.total] : receiptSources.inclusive, arithmeticTaxMode ? ["GST inclusion was inferred from arithmetic and requires confirmation."] : uncertain.has("charges") ? ["GST treatment requires confirmation."] : []),
    total: fieldEvidence(r.receiptTotalCents === null ? "unknown" : "observed", receiptSources.total, totalConflict ? ["Printed payable totals conflict or carry an unresolved sign."] : r.receiptTotalCents === null ? ["No printed payable-total label and amount were identified."] : []),
    suggestedTotal: fieldEvidence(tenderSuggestion === null ? "unknown" : "inferred", tenderSuggestion === null ? [] : source([payments[0]!.index]), tenderSuggestion === null ? [] : ["A payment amount suggests a total but does not independently establish the printed payable total."]),
    rows: fieldEvidence("observed", r.rows!.filter((row) => row.role === "ambiguous").flatMap((row) => row.sources), r.rows!.some((row) => row.role === "ambiguous" && row.needsReview) ? ["Some receipt rows have an unresolved financial role; inspect their retained text."] : []),
  };
  if (arithmeticTaxMode) { uncertain.add("charges"); warnings.push("GST inclusion was inferred from arithmetic. Confirm whether GST is included or added."); }
  if (items.some((item) => item.quantityExact === null)) warnings.push("Some quantities were not identified. A displayed 1 is a placeholder; confirm the highlighted quantities.");

  if (r.receiptTotalCents === null) { uncertain.add("total"); warnings.push("Receipt total not found — enter it to check the maths."); }
  r.uncertainFields = [...uncertain];
  r.ocrWarnings = warnings.slice(0, 20).map((w) => w.slice(0, 300));
  return { receipt: applyImplicitQuantityDefaults(r, text), warnings };
}

const fmt = (c: number) => (c / 100).toFixed(2);

/**
 * Decides whether printed tax is ADDED on top of item prices or already INCLUDED, using the printed
 * numbers only (a per-item "(GST*)" marker alone does not imply either). Ambiguity is flagged.
 */
function reconcileCharges(
  r: Receipt,
  { sum, serviceAmt, taxAmt, anyTaxMarked, complete }: { sum: number; serviceAmt: number | null; taxAmt: number | null; anyTaxMarked: boolean; complete: boolean },
  warnings: string[],
  uncertain: Set<string>,
) {
  const sub = r.printedSubtotalCents;
  // Compare charge treatment before final bill rounding. The printed total
  // remains independent and is never overwritten or rounded a second time.
  const total = r.receiptTotalCents === null ? null : r.receiptTotalCents - (r.roundingApplied ? r.roundingAdjustmentCents ?? 0 : 0);
  const svc = serviceAmt ?? 0;
  const discounted = sum - r.discountCents;

  if (serviceAmt === null && taxAmt === null) {
    r.serviceEnabled = false;
    r.gstEnabled = false;
    uncertain.add("charges");
    warnings.push(r.gstInclusive
      ? "Prices are marked GST included, but no GST amount was printed or recognised. The included tax amount remains unknown."
      : anyTaxMarked
      ? "Items are marked as GST items but no tax amount was found. Check whether prices include GST."
      : "No service charge or GST lines were found. Turn them on if the receipt has them.");
    if (complete && sub !== null && sub !== sum) {
      uncertain.add("items");
      warnings.push(`Items add up to ${fmt(sum)} but the printed subtotal is ${fmt(sub)}. Some lines may be missing or misread.`);
    }
    return;
  }

  r.chargeMode = "receipt";
  r.serviceEnabled = serviceAmt !== null;
  r.serviceAmountCents = serviceAmt;
  r.gstEnabled = taxAmt !== null;
  r.gstAmountCents = taxAmt;
  const tax = taxAmt ?? 0;

  // Evidence for each interpretation, from printed numbers only.
  const inclusiveEvidence =
    (sub !== null && taxAmt !== null && sub + svc + tax === sum && sub !== sum) ||
    (total !== null && taxAmt !== null && total === discounted + svc && tax > 0 && (sub === null || sub === sum));
  const exclusiveEvidence =
    (sub !== null && sub === sum && (total === null || total === discounted + svc + tax)) ||
    (sub === null && total !== null && total === discounted + svc + tax);

  if (inclusiveEvidence && !exclusiveEvidence && r.gstEnabled) {
    r.gstInclusive = true;
    // Printed subtotal is the pre-tax (net) figure; keep it separate from the GST-inclusive item sum.
    if (sub !== null && sub !== sum) {
      r.printedNetSubtotalCents = sub;
      r.printedSubtotalCents = null;
    }
    warnings.push(`Prices already include GST (${fmt(tax)}). GST will not be added again.`);
    if (total !== null && total !== discounted + svc) uncertain.add("total");
    return;
  }
  if (exclusiveEvidence && !inclusiveEvidence) {
    if (r.gstInclusive) {
      // A printed "incl. GST" note contradicts the arithmetic.
      r.gstInclusive = false;
      uncertain.add("charges");
      warnings.push("The receipt mentions GST included, but its numbers show GST added on top. Please confirm.");
    }
    return;
  }

  // Neither (or both) interpretations fit the printed numbers exactly.
  uncertain.add("charges");
  if (complete) uncertain.add("items");
  const parts = [`items ${fmt(sum)}`];
  if (sub !== null) parts.push(`printed subtotal ${fmt(sub)}`);
  if (serviceAmt !== null) parts.push(`service ${fmt(svc)}`);
  if (taxAmt !== null) parts.push(`tax ${fmt(tax)}`);
  if (total !== null) parts.push(`total ${fmt(total)}`);
  warnings.push(`Couldn't tell whether tax is included or added (${parts.join(", ")}). Some numbers may be misread — check them and the “Prices already include GST” switch.`);
  if (sub !== null && sub !== sum) {
    // Keep the printed figure as evidence but don't present it as a gross subtotal.
    r.printedNetSubtotalCents = sub;
    r.printedSubtotalCents = null;
  }
}

/** Higher = more internally consistent parse. Used to pick between OCR passes. */
export function scoreParse(r: Receipt): number {
  // A footer-only reading cannot replace a reading containing recoverable item rows,
  // even when those rows still need manual correction. Keep their uncertainty intact.
  if (r.items.length === 0) return Number.NEGATIVE_INFINITY;
  const priced = r.items.filter((i) => i.lineTotalCents !== null);
  const sum = priced.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  let score = priced.length * 2 - (r.items.length - priced.length) * 2 - r.items.filter((i) => i.flagged).length;
  if (r.receiptTotalCents !== null) score += 2;
  const svc = r.serviceEnabled ? r.serviceAmountCents ?? 0 : 0;
  const tax = r.gstEnabled ? r.gstAmountCents ?? 0 : 0;
  const expected = sum - r.discountCents + svc + (r.gstInclusive ? 0 : tax);
  if (priced.length && r.receiptTotalCents === expected) score += 10;
  if (!r.uncertainFields?.includes("charges")) score += 4;
  if (!r.uncertainFields?.includes("items")) score += 2;
  return score;
}

