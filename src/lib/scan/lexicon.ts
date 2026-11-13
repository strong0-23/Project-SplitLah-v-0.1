/**
 * Receipt vocabulary. Pure data + one classifier. Summary labels are matched against the WHOLE
 * cleaned label (anchored), never as substrings, so product names such as "BUTTER CHICKEN B.LESS",
 * "TAX-FREE COLA" or "SERVICE TEA" are never misread as charges.
 *
 * Covers English plus the Malay/Indonesian, German, French, Spanish/Italian and Dutch terms most
 * often seen on receipts. Add a term here — not in the parser — to support a new receipt style.
 */

export type LineKind =
  | "subtotal"
  | "service"
  | "tax"
  | "discount"
  | "rounding"
  | "total"
  | "payment"
  | "count"
  /** "Total savings" / "Total discount": a summary of discounts, never deducted again (P3). */
  | "savings"
  | "info"
  | "noise";

const CUR = String.raw`(?:\s*\(?\s*(?:s\$|sgd|rm|myr|rp|idr|usd|eur|gbp|jpy|\$|€|£|¥)\s*\)?)?`;
const END = String.raw`${CUR}\s*:?$`;

/** Order-level fees folded into the service charge (D6). Shared by the classifier and `FEE`. */
const FEE_TERMS = String.raw`delivery(?:\s*(?:fee|charge|chg))?|(?:platform|packaging|packing|small[\s-]*order|booking)\s*(?:fee|charge|chg)|caj\s*penghantaran|biaya\s*(?:pengiriman|antar|kemasan)|ongkos\s*kirim|ongkir|liefergeb(?:ü|ue)hr|frais\s*de\s*livraison|gastos\s*de\s*env(?:í|i)o|costo\s*di\s*consegna|bezorgkosten`;

/** A service-classified label that is really a delivery/platform/packaging/small-order fee. */
export const FEE = new RegExp(String.raw`^(?:${FEE_TERMS})\b`, "i");

const R: Array<[LineKind, RegExp]> = [
  // Counts before totals: "Total QTY 10" / "Total items: 4" are never money.
  [
    "count",
    /^(?:total\s*)?(?:qty|quantity|items?|item\s*count|pax|no\.?\s*of\s*items|jumlah\s*(?:item|barang)|anzahl)(?:\s*[:#=]?\s*\d+)?\s*$/i,
  ],
  // A summary of the discounts above it (parser-v2): compared with them, never deducted again.
  [
    "savings",
    /^(?:(?:total\s*)?(?:savings?|saved|discounts)|total\s*disc(?:ount)?|you\s*saved|your\s*savings|savings?\s*total)\b/i,
  ],
  // Informational lines with amounts that are not part of the bill.
  [
    "info",
    /^(?:points?|bonus|reward|loyalty|balance\s*points|(?:suggested|tip\s*suggestions?)|(?:net|gross)\s*weight|vat\s*(?:summary|analysis)|tax\s*summary|gst\s*summary|excl(?:uding)?\s*gst\s*summary)\b/i,
  ],
  [
    "subtotal",
    new RegExp(
      String.raw`^(?:sub\s*-?\s*total|subttl|sub\s*ttl|sales\s*(?:amount|amt|total)|net\s*sales|nett?\s*sub\s*-?\s*total|food\s*total|item\s*total|(?:total|amount)\s*(?:before|excl(?:uding|\.)?|w/?o|without)\s*(?:tax|gst|vat|sst)|jumlah\s*kecil|zwischensumme|sous[\s-]*total|subtotaal|subtotale)${END}`,
      "i",
    ),
  ],
  // Tax before service: Malaysia's "Service Tax 6%" is a tax, not a service charge.
  [
    "tax",
    /^(?:total\s*)?(?:gst|vat|tax|sst|pb\s*1|ppn|cukai|mwst|ust|tva|iva|btw|sales\s*tax|service\s*tax|local\s*tax|city\s*tax|state\s*tax|consumption\s*tax)\b|^(?:(?:incl(?:usive|udes?|uded|\.)?|inkl\.?)\s*(?:of\s*)?)(?:\d{1,2}(?:[.,]\d+)?\s*%\s*)?(?:gst|vat|tax|sst|mwst|tva|iva|btw)\b|^(?:tax|gst|vat)\s*(?:total|amount|amt)\b/i,
  ],
  // Delivery, platform, packaging and small-order fees count as a service charge (decision D6):
  // they are spread in proportion to what each person ordered, never shown as an item.
  [
    "service",
    new RegExp(
      String.raw`^(?:service(?:\s*(?:charge|chg|fee))?|svc(?:\s*chg)?|s\/?c|svr\s*chg|srv\s*chg|sc|gratuity|tip|caj\s*perkhidmatan|biaya\s*layanan|servis|service\s*compris|servizio|coperto|bedienung|${FEE_TERMS})\b`,
      "i",
    ),
  ],
  [
    "discount",
    /^(?:disc(?:ount)?|less\b|promo(?:tion)?|voucher|member\s*disc(?:ount)?|coupon|rebate|markdown|diskaun|potongan|diskon|rabatt|remise|descuento|sconto|korting)/i,
  ],
  [
    "rounding",
    /^(?:(?:(?:cash|bill|final)\s*)?round(?:ing)?(?:\s*(?:adj(?:ustment)?|off|diff))?|pembulatan|rundung)\b/i,
  ],
  [
    "total",
    new RegExp(
      String.raw`^(?:grand\s*total|total(?:\s*(?:amount|amt|due|payable|sale|bill|inc(?:l(?:uding|usive)?)?\.?\s*(?:of\s*)?(?:gst|vat|tax)))?|nett?\s*(?:amount|total)|amount(?:\s*(?:due|payable|to\s*pay))?|to\s*pay|balance\s*due|bill\s*total|jumlah(?:\s*(?:besar|bersih|bayar|keseluruhan))?|total\s*bayar|summe|gesamt(?:summe|betrag)?|montant(?:\s*total)?|total\s*(?:à|a)\s*payer|totale|importe|te\s*betalen|totaal)${END}`,
      "i",
    ),
  ],
  [
    "payment",
    /^(?:cash|change|visa|master\s*card|mastercard|master|amex|nets|pay\s*now|paylah|grab\s*pay|shopee\s*pay|touch\s*['’]?n\s*go|tng|apple\s*pay|google\s*pay|alipay|wechat|card|credit|debit|eftpos|contactless|paid|payment|tender(?:ed)?|balance(?!\s*due)|tunai|kembali(?:an)?|bayar|bar\b|rückgeld|wechselgeld|espèces|rendu|efectivo|cambio|contanti|resto|pin\b|approved|auth)/i,
  ],
  // Header/footer lines that may contain number-like text but never an item price.
  [
    "noise",
    /^(?:tel|phone|fax|hp|date|time|trans(?:action)?\.?\s*(?:no|#|date|time|id|ref|type)|txn|appr(?:oval)?\.?\s*(?:no|code)|auth(?:orisation|orization)?\.?\s*(?:no|code)|rrn|stan|entry\s*mode|aid|tvr|tsi|receipt\s*(?:no|#)|invoice\s*(?:no|#)|inv\s*no|order\s*(?:no|#)|bill\s*(?:no|number|#)|chk|check\s*#|table|tbl|pos|terminal|cashier|server|waiter|staff|gst\s*reg|uen|npwp|co\.?\s*reg|reg\s*no|abn|vat\s*(?:no|reg|id)|ust[\s-]*id|tax\s*id|member\s*(?:no|id)|card\s*no|ref|trace|batch|mid|tid|thank|www\.|http|page)\b/i,
  ],
  // Card-terminal, approval and receipt-admin blocks (never items). Separate from the entry above
  // because these forms end in "#" or ":" rather than at a word boundary.
  [
    "noise",
    /^(?:approval|cardholder|arqc|acquirer)\b|^(?:appr\.?|ref|reference|rec(?:eipt)?\.?|slip|shift|sale|card)\s*(?:no\b|num(?:ber)?\b|#|:)|^(?:station|device|register|till|lane|pos|terminal|batch|trace)\s*(?:id\b|no\b|#|:)|^(?:merchant|customer|store|cardholder)\s*copy\b|^(?:no\s*)?sign(?:ature)?\s*(?:here|below|required|not\s*required)\b|^(?:tc|aid|tvr|tsi|atc|iad|app\s*label|application\s*label)\s*[:#]|^order\s*type\b/i,
  ],
];

/**
 * Words allowed after a charge/payment keyword. Anything else means the keyword starts a product
 * name ("SERVICE TEA", "TAX-FREE COLA", "CHANGE BURGER", "PROMO LUNCH SET"), so the line is an item.
 */
const TAIL_WORDS = new Set(
  (
    "charge chg chrg fee fees total amount amt rate incl inclusive included include includes " +
    "excl exclusive of on at and the sales service tax gst vat sst ppn mwst tva iva btw adj adjustment " +
    "off member members disc discount promo promotion voucher coupon code staff senior student applied redeemed redemption " +
    "card cards debit credit tendered tender paid payment due change cash flashpay contactless online ref approved " +
    "sgd myr eur usd gbp jpy idr inr rm rp"
  ).split(" "),
);
const TAIL_CHECKED: ReadonlySet<LineKind> = new Set([
  "tax",
  "service",
  "discount",
  "payment",
  "rounding",
]);

function tailIsChargeWords(label: string, re: RegExp): boolean {
  const m = re.exec(label);
  if (!m) return false;
  const words =
    label
      .slice(m.index + m[0].length)
      // Masked card numbers and references ("XXXX0000[123456]", "****1234") are not words.
      .replace(/[x*#\d][x*#\d\s()[\]/:-]{3,}/gi, " ")
      .toLowerCase()
      .match(/\p{L}{3,}/gu) ?? [];
  return words.every((w) => TAIL_WORDS.has(w));
}

/**
 * Finite OCR label repair (parser-v2): a word whose letters match a summary word once I/l/1/|/!
 * and O/0 and S/5 are treated alike ("T0TAL", "TOTA1", "D1SC0UNT", "G5T") is read as that word.
 * Used ONLY to classify a label; product descriptions and amounts are never changed.
 */
const SUMMARY_WORDS = (
  "subtotal subttl sub sales amount amt total grand net nett due payable balance service charge chg " +
  "gst vat tax incl included inclusive saving savings discount discounts disc voucher coupon " +
  "payment tender tendered cash change visa master mastercard nets paynow paylah credit debit paid " +
  "qty quantity rounding round"
).split(" ");
const skeleton = (w: string) =>
  w
    .toLowerCase()
    .replace(/[il1|!]/g, "!")
    .replace(/0/g, "o")
    .replace(/5/g, "s");
const SKELETONS = new Map(SUMMARY_WORDS.map((w) => [skeleton(w), w]));

export function normaliseLabelWords(label: string): string {
  return label.replace(/[A-Za-z01|!5]{2,}/g, (word) => {
    if (!/[A-Za-z]/.test(word)) return word;
    const known = SKELETONS.get(skeleton(word));
    return known && known !== word.toLowerCase() ? known : word;
  });
}

/**
 * "Total (SGD) incl. GST", "2 TOTAL", "Grand Total ( INCL GST) ©", "Total S": the total label with
 * its printed qualifiers removed (an item count in front, currency marks, an included-tax note).
 */
function totalCore(label: string): string {
  return label
    .replace(/^\d{1,3}\s+(?=\D)/, "")
    .replace(/[()[\]©|]/g, " ")
    .replace(
      /\b(?:inc(?:l(?:uding|usive|uded)?)?|inkl)\.?\s*(?:of\s*)?(?:gst|vat|tax|mwst)\b/gi,
      " ",
    )
    .replace(/\b\d{1,3}\s*(?:items?|pcs|pieces|qty)\b/gi, " ")
    .replace(/\b(?:sgd|s\s*\$|s)\b|\$/gi, " ")
    .replace(/[:;=]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A discount, voucher or coupon code after a separator ("Discount: ABC-1", "Voucher #A12"). Only a
 * code containing a digit, so "PROMO: SET A" (a product) is never read as a discount (parser-v2).
 */
const DISCOUNT_CODE = /\s*[:#-]\s*(?=[\w-]*\d)[\w-]+$/;

function classifyExact(label: string): LineKind | null {
  for (const [kind, re] of R) {
    const subject = kind === "discount" ? label.replace(DISCOUNT_CODE, "") : label;
    if (!re.test(subject)) continue;
    if (TAIL_CHECKED.has(kind) && !tailIsChargeWords(subject, re)) continue;
    return kind;
  }
  return null;
}

const TOTAL_RE = R.find(([k]) => k === "total")![1];
/** Kinds a single stray margin character may precede ("E GST AMT", "4 Total saving"). */
const MARGIN_OK: ReadonlySet<LineKind> = new Set([
  "tax",
  "savings",
  "total",
  "subtotal",
  "service",
]);

/** Classifies a cleaned label (text before the amount). null = not a summary/noise line. */
export function classifyLabel(label: string): LineKind | null {
  const exact = classifyExact(label);
  if (exact) return exact;
  const words = normaliseLabelWords(label);
  const repaired = words !== label ? classifyExact(words) : null;
  if (repaired) return repaired;
  if (
    TOTAL_RE.test(totalCore(words)) &&
    /\b(?:total|amount|due|payable|jumlah|summe)\b/i.test(words)
  )
    return "total";
  const margin = /^[A-Za-z0-9]\s+(.+)$/.exec(words);
  if (margin) {
    const kind = classifyExact(margin[1]!);
    if (kind && MARGIN_OK.has(kind)) return kind;
  }
  return null;
}

/**
 * D15: the printed number of items sold ("Total Qty 7", "Total 5 items", "Items: 3",
 * "No. of items 4", "Jumlah barang 2", "Anzahl Artikel 3", "Nombre d'articles 3"). Returns the
 * number as printed (it may not be whole: the parser checks), or null when the label is not an
 * item count. Matched on the whole label with its delimiters, so a product name ("ITEM 7 COMBO")
 * or a per-row "Qty 2" is never read as a count; "Pax" counts people, not items.
 */
const COUNT_NUM = String.raw`\s*[:#=]?\s*(\d+(?:[.,]\d+)?)`;
const COUNT_WORDS = String.raw`(?:total\s*(?:qty|quantity|items?|item\s*count|pcs|pieces|articles?|art(?:í|i)culos|articoli|artikel)|items|item\s*count|no\.?\s*of\s*items?|number\s*of\s*items?|jumlah\s*(?:item|barang)|bilangan\s*(?:item|barang)|anzahl\s*artikel|artikelanzahl|nombre\s*d['’]?\s*articles|nb\.?\s*(?:d['’]?\s*)?articles|n(?:ú|u)mero\s*de\s*art(?:í|i)culos|cantidad\s*de\s*art(?:í|i)culos|numero\s*(?:di\s*)?articoli|totale\s*articoli|aantal\s*(?:artikelen|artikels|items))`;
const ITEM_COUNT = new RegExp(
  String.raw`^${COUNT_WORDS}${COUNT_NUM}$|^total${COUNT_NUM}\s*(?:items?|pcs|pieces|qty|articles?|artikel|articoli|art(?:í|i)culos)$`,
  "i",
);
export function itemCountOf(label: string): string | null {
  const m = ITEM_COUNT.exec(label.trim());
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Words that never belong in an item note (P1): summary, payment, date/time and transaction
 * vocabulary. Checked on the repaired label, as whole words.
 */
export const NOT_A_NOTE =
  /\b(?:sub\s*-?\s*total|subttl|total|grand|amount|amt|balance|due|payable|gst|vat|tax|sst|service|svc|charge|disc(?:ount)?|savings?|rounding|round|cash|change|visa|master(?:card)?|nets|paynow|paylah|card|credit|debit|paid|payment|tender(?:ed)?|date|time|transaction|trans|txn|receipt|invoice|approval|appr|auth|ref|terminal|cashier|thank|sgd|incl(?:usive|uded)?)\b/i;

/** Qty heading words, including the finite OCR confusions parser-v2 accepts in a full heading. */
const QTY_WORD = String.raw`(?:qty|quantity|qiy|qly|aty|q1y|qtl)`;
/** Which bare-quantity columns a heading line establishes; null if the line is not a heading. */
export function qtyColumnsOf(header: string): { leading: boolean; trailing: boolean } | null {
  if (!ITEM_HEADER.test(header)) return null;
  const hasQty = new RegExp(String.raw`\b${QTY_WORD}\b`, "i").test(header);
  const leading = new RegExp(String.raw`^\s*${QTY_WORD}\b`, "i").test(header);
  return { leading: hasQty && leading, trailing: hasQty && !leading };
}

/** A heading with a separate unit-price column ("Item Unit($) Qty Amount", "Description Price Qty Total"). */
export const UNIT_PRICE_HEADER =
  /\bunit\b|\bprice\b.*\b(?:amount|amt|total)\b|\b(?:amount|amt|total)\b.*\bprice\b/i;

/** Column headings above the item list: "Item Qty Price Amount", "Description Total". */
export const ITEM_HEADER =
  /\b(?:products?|items?|descriptions?|desc|menu|artikel|article|désignation|barang)\b.*\b(?:qty|quantity|qiy|qly|aty|q1y|qtl|total|amount|price|amt|harga|jumlah|betrag|prix|preis|montant)\b|^\s*qty\s+(?:items?|descriptions?|desc)\b|\bunit(?:\s*price)?\b.*\b(?:qty|quantity|qiy|qly|aty|q1y|qtl)\b.*\b(?:amount|amt|total)\b/i;

/** "Prices include GST", "GST inclusive", "incl. 19% MwSt". */
export const INCLUSIVE_NOTE =
  /\b(?:incl(?:usive|udes?|uded|\.)?|inkl\.?|termasuk|ttc)\b.*\b(?:gst|vat|tax|sst|mwst|tva|iva|btw|ppn|pb1|cukai|pajak)\b|\binc\.?\s*(?:of\s*)?(?:gst|vat|tax)\b|\b(?:gst|vat|tax|sst|mwst|tva|iva|btw)\b.*\b(?:incl(?:usive|uded|\.)?|inkl\.?|included)\b/i;

/** Per-item tax markers after a product name: "NAAN(GST*)", "(T)", "(SR)". OCR turns "*" into #,+,x,¥,%. */
export const ITEM_TAX_MARKER =
  /\s*[([{]\s*(?:GST|BST|6ST|VAT|SR|T|ZR|TX)\s*[*#+x×¥%&]*\s*[)\]}]?\s*$|\s+[*#](?:[A-Z])?$/;

/**
 * Modifier / add-on lines printed under an item: "+ Oat milk", "> Less sugar", "Add egg", "w/ cheese",
 * and preparation notes ("Warm up", "Toasted"). Since Batch 1b (P1) these are the ONLY unpriced
 * lines attached to the item above; any other product-like line becomes its own flagged item.
 */
export const MODIFIER =
  /^(?:[+>~•·*]\s*|-\s+(?=[a-z])|(?:add|extra|with|w\/|no|less|more|without|sub|swap|upsize|tambah|kurang|ohne|mit|sans|avec)\s|(?:warm(?:\s*up)?|heat(?:ed)?(?:\s*up)?|toast(?:ed)?|slice[sd]?|cut|separate(?:ly)?|spicy|mild|well\s*done|medium|rare)(?:\s|$))/i;

/** Header lines that are never the merchant name. */
export const NOT_MERCHANT =
  /^(?:table|tbl|final\s*receipt|receipt|tax\s*invoice|invoice|simplified\s*tax|bill|order|cashier|waiter|server|date|time|tel|phone|gst\s*reg|uen|copy|reprint|welcome|thank|duplicate|customer|dine\s*in|take\s*away|takeaway|pax|check)/i;

/**
 * Address details printed in the header: unit/block numbers, street types, postcodes. Used only
 * before the first item, so a product such as "Singapore Sling" is never affected.
 */
export const ADDRESS =
  /#\s?\d{1,3}-\d{1,5}\b|\b(?:blk|block)\s*\d|\b(?:unit|level|lvl|lot|suite)\s*#?\d|\b(?:singapore|s)\s*\(?\d{6}\)?(?!\S)|\b\d{1,5}[a-z]?,?\s+(?:\p{L}+\s+){0,3}(?:road|rd|street|st|avenue|ave|drive|dr|lane|ln|crescent|cres|boulevard|blvd|place|pl|way)\b|\b(?:jalan|jln|lorong|lor|persiaran|taman|stra(?:ß|ss)e|rue|calle|via)\s+\p{L}/iu;

/**
 * Weighed goods: a measured weight ("0.512 kg", "1,25 kg") or a per-weight price ("@ 3.98/kg").
 * A whole-number package size ("MILO 1KG", "MILK 500ml") is part of the name, not a weighing.
 */
export const WEIGHT = /\d+[.,]\d{1,3}\s?(?:kg|g|lb|lbs|oz|l|ml)\b|\/\s?(?:kg|g|lb|lbs|100\s?g)\b/i;

/**
 * An unpriced tax/financial note damaged by OCR ("Total GST AMT DETAILS 9 £ 90"): never a product,
 * and the numeric fragments under it are never joined to one (parser-v2 rule).
 */
export function isFinancialNote(label: string): boolean {
  const words = normaliseLabelWords(label);
  const taxContext =
    /^(?:(?:total\s+)?(?:gst|vat|tax)\b|(?:prices?|amounts?|total)\b.*\b(?:gst|vat|tax)\b)/i.test(
      words,
    );
  const monetaryCue = /[%$£€¥]|\b(?:SGD|USD|MYR)\b/i.test(label);
  const numericSummary =
    /^(?:total\s*)?(?:gst|vat|tax)\s+(?:amt|amount|rate)\b/i.test(words) && /\d/.test(label);
  return taxContext && (monetaryCue || numericSummary);
}

/**
 * Unit prices and line amounts printed on different tax bases: "Unit (incl GST) … Amount (excl GST)",
 * or "Unit prices exclude GST" with "Line amount includes GST" (parser-v2). A quantity worked out
 * from such a unit price and line amount would be wrong.
 */
export function mixedTaxBasis(lines: readonly string[]): boolean {
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  return (
    (has(/\bunit\b.*\bexcl/i) && has(/\b(?:amount|total)\b.*\bincl/i)) ||
    (has(/\bunit\b.*\bincl/i) && has(/\b(?:amount|total)\b.*\bexcl/i))
  );
}

/**
 * A tax-table heading with no amounts: rate/net/tax/gross columns ("Tax  Net  Tax  Gross",
 * "GST Rate  Excl.  GST  Incl."). The rows under it print net + tax = gross.
 */
export const TAX_TABLE_HEADER =
  /\b(?:net|nett|excl(?:\.|uding|usive)?|before\s*tax)\b.*\b(?:tax|gst|vat|sst|mwst|tva|iva|btw)\b.*\b(?:gross|incl(?:\.|uding|usive)?|brutto|ttc)\b/i;

/** Payment-line labels that give money back ("Change 7.20"), and cash tenders. */
export const CHANGE_LABEL =
  /^(?:change|change\s*due|kembali(?:an)?|baki|rückgeld|wechselgeld|rendu|cambio|resto|vuelto)\b/i;
export const CASH_LABEL = /^(?:cash|tunai|bar\b|espèces|efectivo|contanti|contant)/i;

/**
 * How strongly a total label says "this is what was paid": 3 for grand/payable/incl.-tax totals,
 * 2 for a plain "Total", 1 for weaker words ("Amount", "Jumlah", "Nett amount").
 */
export function totalLabelStrength(words: string): number {
  if (
    /\b(?:grand\s*total|total\s*(?:due|payable|to\s*pay|bill)|amount\s*(?:due|payable)|balance\s*due|inc(?:l(?:uding|usive)?)?\.?\s*(?:of\s*)?(?:gst|vat|tax))\b/i.test(
      words,
    )
  )
    return 3;
  return /\btotal\b/i.test(words) ? 2 : 1;
}
