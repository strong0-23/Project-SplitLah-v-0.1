import { formatMoney, formatRate, isSafeCents, parseMoney, parseRate } from "./money";
import { confirmReceiptField } from "./receipt-quality";
import type { FieldEvidence, Receipt, ReceiptField, SourceEvidence } from "./types";

export type PrintedChargeField = "service" | "gst" | "serviceRateBp" | "gstRateBp" | "gstInclusive";
export interface PrintedChargeConfirmation {
  field: PrintedChargeField;
  label: string;
  valueLabel: string;
  sources: SourceEvidence[];
}

const printedSource = (source: SourceEvidence) =>
  (source.kind === "text" || source.kind === "geometry") && !!source.text?.trim();
const sourceText = (evidence: FieldEvidence) => evidence.sources.filter(printedSource).map(source => source.text!);
const labels = {
  service: /\b(?:service(?:\s+charge)?|svc(?:\s+charge)?)\b/i,
  gst: /\bGST\b/i,
};
const percentValues = (text: string) => [...text.matchAll(/\b(\d{1,3}(?:\.\d{1,2})?)\s*%/g)].map(match => parseRate(match[1]!));
const amountValues = (text: string) => [...text.replace(/\b\d{1,3}(?:\.\d{1,2})?\s*%/g, "").matchAll(/(?<![\d.,+-])(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d.%])/g)].map(match => parseMoney(match[0]));
/** Only known financial decorations may surround a complete label. A product
 * containing GST/service is not printed charge evidence, even if amounts match. */
function financialLabelContext(text: string, charge: "service" | "gst"): boolean {
  const label = text.replace(/\b\d{1,3}(?:\.\d{1,2})?\s*%/g, " ")
    .replace(/(?<![\d.,+-])(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}(?![\d.%])/g, " ")
    .replace(/\bSGD\b|\bS\s*\$|\$/gi, " ")
    .replace(/[():=@]/g, " ").replace(/\s+/g, " ").trim();
  return charge === "service"
    ? /^(?:no\s+)?(?:service(?:\s+(?:charge|chg))?|svc(?:\s+(?:charge|chg))?|svr\s+chg|s\/c|sc)(?:\s+(?:none|nil|not\s+applicable))?$/i.test(label)
    : /^(?:(?:no\s+)?GST(?:\s+(?:(?:is\s+)?(?:included|inclusive|added|exclusive)|exempt|none|nil|not\s+applicable))?|(?:prices?|amounts?)\s+(?:already\s+)?include\s+GST|(?:inclusive|exclusive)\s+of\s+GST|excluding\s+GST)$/i.test(label);
}
function financialSources(evidence: FieldEvidence, charge: "service" | "gst"): string[] {
  const texts = sourceText(evidence).filter(text => labels[charge].test(text));
  return texts.every(text => financialLabelContext(text, charge)) ? texts : [];
}
const containsSignedAmount = (text: string) => /[-+\u2212\u2013\u2014]\s*(?:S?\$\s*)?\d+[.,]\d{2}|\d+[.,]\d{2}\s*[-\u2212]|\(\s*(?:S?\$\s*)?\d+[.,]\d{2}\s*\)/i.test(text);
const explicitAbsence = {
  service: /\b(?:no\s+(?:service|svc)(?:\s+charge)?|(?:service|svc)(?:\s+charge)?\s*[:=]?\s*(?:none|nil|not\s+applicable))\b/i,
  gst: /\b(?:no\s+GST|GST\s*[:=]?\s*(?:exempt|none|nil|not\s+applicable))\b/i,
};

/** This is a conservative confirmation filter, not an additional OCR/extraction pass. */
function independentEvidence(evidence: FieldEvidence | undefined): evidence is FieldEvidence {
  return !!evidence && evidence.origin === "observed" && !evidence.needsReview &&
    evidence.reasons.length === 0 && evidence.sources.some(printedSource) &&
    !evidence.sources.some(source => source.kind === "calculation" || source.kind === "preference");
}

function amountSupported(evidence: FieldEvidence, charge: "service" | "gst", cents: number): boolean {
  const sources = financialSources(evidence, charge);
  if (!sources.length || sources.some(text => containsSignedAmount(text) || explicitAbsence[charge].test(text))) return false;
  const values = sources.flatMap(amountValues);
  return values.length > 0 && values.every(value => value === cents);
}

function absenceSupported(evidence: FieldEvidence, charge: "service" | "gst"): boolean {
  const texts = financialSources(evidence, charge);
  return texts.length > 0 && texts.every(text => !containsSignedAmount(text) &&
    (explicitAbsence[charge].test(text) || (amountValues(text).length > 0 && amountValues(text).every(value => value === 0)))) &&
    texts.flatMap(amountValues).every(value => value === 0) && texts.flatMap(percentValues).every(value => value === 0);
}

function rateSupported(evidence: FieldEvidence, charge: "service" | "gst", rate: number): boolean {
  const sources = financialSources(evidence, charge);
  const values = sources.flatMap(percentValues);
  return sources.length > 0 && !sources.some(text => explicitAbsence[charge].test(text)) && values.length > 0 && values.every(value => value === rate);
}

function treatmentSupported(evidence: FieldEvidence, inclusive: boolean): boolean {
  const texts = financialSources(evidence, "gst");
  const included = texts.some(text => /\bGST\s*(?:is\s*)?(?:included|inclusive)\b|\b(?:prices?|amounts?)\s+(?:already\s+)?include\s+GST\b|\binclusive\s+of\s+GST\b/i.test(text));
  const added = texts.some(text => /\bGST\s*(?:is\s*)?(?:added|exclusive)\b|\b(?:excluding|exclusive\s+of)\s+GST\b/i.test(text));
  return inclusive ? included && !added : added && !included;
}

export function eligiblePrintedChargeConfirmations(receipt: Receipt): PrintedChargeConfirmation[] {
  const result: PrintedChargeConfirmation[] = [];
  for (const charge of ["service", "gst"] as const) {
    const evidence = receipt.evidence?.[charge];
    if (!independentEvidence(evidence)) continue;
    const enabled = charge === "service" ? receipt.serviceEnabled : receipt.gstEnabled;
    const amount = charge === "service" ? receipt.serviceAmountCents : receipt.gstAmountCents;
    const rate = charge === "service" ? receipt.serviceRateBp : receipt.gstRateBp;
    const supported = !enabled ? absenceSupported(evidence, charge)
      : receipt.chargeMode === "percentage" ? rateSupported(evidence, charge, rate)
      : isSafeCents(amount) && amountSupported(evidence, charge, amount);
    if (supported) result.push({ field: charge, label: charge === "service" ? "Service charge" : "GST",
      valueLabel: !enabled ? "No charge" : receipt.chargeMode === "percentage" ? `${formatRate(rate)}% applies` : formatMoney(amount!), sources: evidence.sources });
  }
  if (receipt.chargeMode === "percentage") for (const charge of ["service", "gst"] as const) {
    const field = charge === "service" ? "serviceRateBp" : "gstRateBp";
    const enabled = charge === "service" ? receipt.serviceEnabled : receipt.gstEnabled;
    const evidence = receipt.evidence?.[field];
    const rate = receipt[field];
    if (enabled && independentEvidence(evidence) && rateSupported(evidence, charge, rate))
      result.push({ field, label: charge === "service" ? "Service-charge rate" : "GST rate", valueLabel: `${formatRate(rate)}%`, sources: evidence.sources });
  }
  const treatment = receipt.evidence?.gstInclusive;
  if (receipt.gstEnabled && independentEvidence(treatment) && treatmentSupported(treatment, receipt.gstInclusive))
    result.push({ field: "gstInclusive", label: "GST treatment", valueLabel: receipt.gstInclusive ? "Included in prices" : "Added to prices", sources: treatment.sources });
  return result;
}

/** Recheck eligibility at the time of the click; no selected field can establish another field. */
export function confirmPrintedChargeFields(receipt: Receipt, selected: readonly ReceiptField[]): {
  receipt: Receipt;
  confirmedFields: PrintedChargeField[];
  fieldActions: number;
} {
  const eligible = new Set(eligiblePrintedChargeConfirmations(receipt).map(candidate => candidate.field));
  const confirmedFields = [...new Set(selected)].filter((field): field is PrintedChargeField => eligible.has(field as PrintedChargeField));
  return { receipt: confirmedFields.reduce((next, field) => confirmReceiptField(next, field), receipt),
    confirmedFields, fieldActions: confirmedFields.length };
}
