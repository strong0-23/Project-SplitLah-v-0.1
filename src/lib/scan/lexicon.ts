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
  | "info"
  | "noise";

const CUR = String.raw`(?:\s*\(?\s*(?:s\$|sgd|rm|myr|rp|idr|usd|eur|gbp|jpy|\$|€|£|¥)\s*\)?)?`;
const END = String.raw`${CUR}\s*:?$`;

const R: Array<[LineKind, RegExp]> = [
  // Counts before totals: "Total QTY 10" / "Total items: 4" are never money.
  [
    "count",
    /^(?:total\s*)?(?:qty|quantity|items?|item\s*count|pax|no\.?\s*of\s*items|jumlah\s*(?:item|barang)|anzahl)\b/i,
  ],
  // Informational lines with amounts that are not part of the bill.
  [
    "info",
    /^(?:(?:total\s*)?(?:savings?|saved|you\s*saved|your\s*savings)|points?|bonus|reward|loyalty|balance\s*points|(?:suggested|tip\s*suggestions?)|(?:net|gross)\s*weight|vat\s*(?:summary|analysis)|tax\s*summary|gst\s*summary|excl(?:uding)?\s*gst\s*summary)\b/i,
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
    /^(?:service(?:\s*(?:charge|chg|fee))?|svc(?:\s*chg)?|s\/?c|svr\s*chg|srv\s*chg|sc|gratuity|tip|caj\s*perkhidmatan|biaya\s*layanan|servis|service\s*compris|servizio|coperto|bedienung|delivery(?:\s*(?:fee|charge|chg))?|(?:platform|packaging|packing|small[\s-]*order|booking)\s*(?:fee|charge|chg)|caj\s*penghantaran|biaya\s*(?:pengiriman|antar|kemasan)|ongkos\s*kirim|ongkir|liefergeb(?:ü|ue)hr|frais\s*de\s*livraison|gastos\s*de\s*env(?:í|i)o|costo\s*di\s*consegna|bezorgkosten)\b/i,
  ],
  [
    "discount",
    /^(?:disc(?:ount)?|less\b|promo(?:tion)?|voucher|member\s*disc|coupon|rebate|markdown|diskaun|potongan|diskon|rabatt|remise|descuento|sconto|korting)/i,
  ],
  [
    "rounding",
    /^(?:(?:cash\s*)?round(?:ing)?(?:\s*(?:adj(?:ustment)?|off|diff))?|pembulatan|rundung)\b/i,
  ],
  [
    "total",
    new RegExp(
      String.raw`^(?:grand\s*total|total(?:\s*(?:amount|amt|due|payable|sale|bill|incl(?:uding|\.)?\s*(?:gst|vat|tax)))?|nett?\s*(?:amount|total)|amount(?:\s*(?:due|payable|to\s*pay))?|to\s*pay|balance\s*due|bill\s*total|jumlah(?:\s*(?:besar|bersih|bayar|keseluruhan))?|total\s*bayar|summe|gesamt(?:summe|betrag)?|montant(?:\s*total)?|total\s*(?:à|a)\s*payer|totale|importe|te\s*betalen|totaal)${END}`,
      "i",
    ),
  ],
  [
    "payment",
    /^(?:cash|change|visa|master\s*card|mastercard|amex|nets|pay\s*now|paylah|grab\s*pay|shopee\s*pay|touch\s*['’]?n\s*go|tng|apple\s*pay|google\s*pay|alipay|wechat|card|credit|debit|eftpos|contactless|paid|payment|tender(?:ed)?|balance(?!\s*due)|tunai|kembali(?:an)?|bayar|bar\b|rückgeld|wechselgeld|espèces|rendu|efectivo|cambio|contanti|resto|pin\b|approved|auth)/i,
  ],
  // Header/footer lines that may contain number-like text but never an item price.
  [
    "noise",
    /^(?:tel|phone|fax|hp|date|time|receipt\s*(?:no|#)|invoice\s*(?:no|#)|inv\s*no|order\s*(?:no|#)|bill\s*(?:no|number|#)|chk|check\s*#|table|tbl|pos|terminal|cashier|server|waiter|staff|gst\s*reg|uen|npwp|co\.?\s*reg|reg\s*no|abn|vat\s*(?:no|reg|id)|ust[\s-]*id|tax\s*id|member\s*(?:no|id)|card\s*no|ref|trace|batch|mid|tid|thank|www\.|http|page)\b/i,
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
      .toLowerCase()
      .match(/\p{L}{3,}/gu) ?? [];
  return words.every((w) => TAIL_WORDS.has(w));
}

/** Classifies a cleaned label (text before the amount). null = not a summary/noise line. */
export function classifyLabel(label: string): LineKind | null {
  for (const [kind, re] of R) {
    if (!re.test(label)) continue;
    if (TAIL_CHECKED.has(kind) && !tailIsChargeWords(label, re)) continue;
    return kind;
  }
  return null;
}

/** Column headings above the item list: "Item Qty Price Amount", "Description Total". */
export const ITEM_HEADER =
  /\b(?:product|item|items|description|desc|menu|artikel|article|désignation|barang)\b.*\b(?:qty|quantity|total|amount|price|amt|harga|jumlah|betrag|prix|preis|montant)\b|^\s*qty\s+(?:item|description|desc)\b/i;

/** "Prices include GST", "GST inclusive", "incl. 19% MwSt". */
export const INCLUSIVE_NOTE =
  /\b(?:incl(?:usive|udes?|uded|\.)?|inkl\.?|termasuk|ttc)\b.*\b(?:gst|vat|tax|sst|mwst|tva|iva|btw|ppn|pb1|cukai|pajak)\b|\b(?:gst|vat|tax|sst|mwst|tva|iva|btw)\b.*\b(?:incl(?:usive|uded|\.)?|inkl\.?|included)\b/i;

/** Per-item tax markers after a product name: "NAAN(GST*)", "(T)", "(SR)". OCR turns "*" into #,+,x,¥,%. */
export const ITEM_TAX_MARKER =
  /\s*[([{]\s*(?:GST|BST|6ST|VAT|SR|T|ZR|TX)\s*[*#+x×¥%&]?\s*[)\]}]?\s*$|\s+[*#](?:[A-Z])?$/;

/** Modifier / add-on lines printed under an item: "+ Oat milk", "> Less sugar", "Add egg", "w/ cheese". */
export const MODIFIER =
  /^(?:[+>~•·*]\s*|-\s+(?=[a-z])|(?:add|extra|with|w\/|no|less|more|without|sub|swap|upsize|tambah|kurang|ohne|mit|sans|avec)\s)/i;

/** Header lines that are never the merchant name. */
export const NOT_MERCHANT =
  /^(?:table|tbl|final\s*receipt|receipt|tax\s*invoice|invoice|simplified\s*tax|bill|order|cashier|waiter|server|date|time|tel|phone|gst\s*reg|uen|copy|reprint|welcome|thank|duplicate|customer|dine\s*in|take\s*away|takeaway|pax|check)/i;

/**
 * Address details printed in the header: unit/block numbers, street types, postcodes. Used only
 * before the first item, so a product such as "Singapore Sling" is never affected.
 */
export const ADDRESS =
  /#\s?\d{1,3}-\d{1,5}\b|\b(?:blk|block)\s*\d|\b(?:unit|level|lvl|lot|suite)\s*#?\d|\b(?:singapore|s)\s*\(?\d{6}\)?(?!\S)|\b\d{1,5}[a-z]?,?\s+(?:\p{L}+\s+){0,3}(?:road|rd|street|st|avenue|ave|drive|dr|lane|ln|crescent|cres|boulevard|blvd|place|pl|way)\b|\b(?:jalan|jln|lorong|lor|persiaran|taman|stra(?:ß|ss)e|rue|calle|via)\s+\p{L}/iu;

/** Weighed goods: "0.512 kg", "1,25 kg", "350 g". */
export const WEIGHT = /\d+(?:[.,]\d{1,3})?\s?(?:kg|g|lb|lbs|oz|l|ml)\b/i;
