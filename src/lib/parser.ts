import { parseMoney, parseRate } from "./money";
import type { Receipt, ReceiptItem } from "./types";
import { newId } from "./ids";
import { emptyReceipt } from "./defaults";

const PRICE_AT_END = /(-?)\s*S?\$?\s*(\d{1,6}(?:,\d{3})*[.,]\d{2})\s*-?\s*[A-Z]?\s*$/i;
const KW = {
  subtotal: /\bsub\s*-?\s*total\b|\bsubttl\b/i,
  total: /\b(grand\s*)?total\b|\bnett?\s*amount\b|\bamount\s*due\b/i,
  service: /\bservice\b|\bsvc\b|\bs\/c\b|\bsvr\b/i,
  gst: /\bgst\b|\bvat\b|\btax\b/i,
  discount: /\bdisc(ount)?\b|\bless\b|\bpromo\b|\bvoucher\b|\boff\b/i,
  payment: /\bcash\b|\bchange\b|\bvisa\b|\bmaster(card)?\b|\bamex\b|\bnets\b|\bpaynow\b|\bpaylah\b|\bgrabpay\b|\bcard\b|\bpaid\b|\bpayment\b|\btender(ed)?\b|\bbalance\b|\brounding\b|\bqty\s*total\b|\bitems?\s*:/i,
  inclusive: /\bincl(usive|\.|uded)?\b|\binclusive\b/i,
};

export interface ParseResult {
  receipt: Receipt;
  warnings: string[];
}

function money(raw: string): number | null {
  // OCR often reads "." as ","; normalise "12,50" → "12.50" when it's the decimal separator.
  const s = raw.replace(/,(\d{2})$/, ".$1").replace(/,/g, "");
  return parseMoney(s);
}

/** Pure parser: turns raw OCR text into a draft receipt. Never invents prices. */
export function parseReceiptText(text: string): ParseResult {
  const r = emptyReceipt();
  r.rawOcrText = text;
  const warnings: string[] = [];
  const uncertain = new Set<string>();
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);

  // Merchant: first line with mostly letters, before any priced line.
  for (const l of lines.slice(0, 5)) {
    if (PRICE_AT_END.test(l)) break;
    const letters = (l.match(/[a-z]/gi) ?? []).length;
    if (letters >= 3 && letters / l.length > 0.5) {
      r.merchant = l.slice(0, 60);
      break;
    }
  }
  if (!r.merchant) uncertain.add("merchant");

  let serviceAmt: number | null = null;
  let gstAmt: number | null = null;
  const items: ReceiptItem[] = [];

  for (const line of lines) {
    const m = PRICE_AT_END.exec(line);
    const lower = line.toLowerCase();
    if (KW.inclusive.test(lower) && KW.gst.test(lower)) r.gstInclusive = true;
    if (!m) continue;
    const amount = money(m[2] ?? "");
    const negative = m[1] === "-" || /-\s*$/.test(line);
    const label = line.slice(0, m.index).trim();
    if (amount === null) continue;

    if (KW.subtotal.test(label)) { r.printedSubtotalCents = amount; continue; }
    if (KW.service.test(label)) {
      serviceAmt = amount;
      const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
      if (rate) { const bp = parseRate(rate[1] ?? ""); if (bp !== null) r.serviceRateBp = bp; }
      continue;
    }
    if (KW.gst.test(label)) {
      gstAmt = amount;
      const rate = /(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(label);
      if (rate) { const bp = parseRate(rate[1] ?? ""); if (bp !== null) r.gstRateBp = bp; }
      continue;
    }
    if (KW.discount.test(label) || (negative && !KW.payment.test(label))) { r.discountCents += amount; continue; }
    if (KW.payment.test(label)) continue;
    if (KW.total.test(label)) { if (r.receiptTotalCents === null) r.receiptTotalCents = amount; continue; }

    // Purchased item. Optional leading quantity: "2 x Foo", "2x Foo", "2 Foo".
    let desc = label;
    let quantity = 1;
    let flagged = false;
    const q = /^(\d{1,3})\s*[x×*]?\s+(.+)$/i.exec(desc) ?? /^(\d{1,3})\s*[x×*]\s*(.+)$/i.exec(desc);
    if (q && Number(q[1]) > 0 && Number(q[1]) < 100) { quantity = Number(q[1]); desc = q[2] ?? desc; }
    // Drop a trailing unit price ("Coffee 2 @ 3.50") — we keep only the line total.
    desc = desc.replace(/\s*@?\s*\$?\d+[.,]\d{2}\s*$/, "").replace(/[^\p{L}\p{N}&'()./+\- ]/gu, "").trim();
    const letters = (desc.match(/\p{L}/gu) ?? []).length;
    if (letters < 2) continue; // noise
    if (letters < 4 || /[|{}\[\]]/.test(label)) flagged = true;
    items.push({ id: newId("i"), description: desc.slice(0, 80), quantity, lineTotalCents: amount, flagged });
  }

  r.items = items;
  if (items.length === 0) warnings.push("No purchased items were recognised. Add them manually.");
  if (items.some((i) => i.flagged)) warnings.push("Some item descriptions look uncertain — please check highlighted lines.");

  if (serviceAmt !== null || gstAmt !== null) {
    r.chargeMode = "receipt";
    r.serviceEnabled = serviceAmt !== null;
    r.serviceAmountCents = serviceAmt;
    r.gstEnabled = gstAmt !== null;
    r.gstAmountCents = gstAmt;
  } else {
    r.serviceEnabled = false;
    r.gstEnabled = false;
    uncertain.add("charges");
    warnings.push("No service charge or GST lines were found. Turn them on if the receipt has them.");
  }

  const sum = items.reduce((s, i) => s + (i.lineTotalCents ?? 0), 0);
  if (r.printedSubtotalCents !== null && r.printedSubtotalCents !== sum) {
    uncertain.add("items");
    warnings.push(`Items add up to ${(sum / 100).toFixed(2)} but the printed subtotal is ${(r.printedSubtotalCents / 100).toFixed(2)}. Some lines may be missing or misread.`);
  }
  if (r.receiptTotalCents === null) { uncertain.add("total"); warnings.push("Receipt total not found — enter it to check the maths."); }
  r.uncertainFields = [...uncertain];
  r.ocrWarnings = warnings;
  return { receipt: r, warnings };
}
