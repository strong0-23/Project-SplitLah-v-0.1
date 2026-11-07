import { isSafeCents, isSafeSignedCents, MAX_RATE_BP } from "./money";
import {
  isValidQuantity,
  itemQuantity,
  parseQuantity,
  quantityNumber,
  validatePriceRelationship,
} from "./quantity";
import type {
  FieldEvidence,
  ItemField,
  Receipt,
  ReceiptField,
  ReceiptItem,
  SourceEvidence,
  ValueOrigin,
} from "./types";

export interface ReceiptReviewReason {
  path: string;
  code: string;
  message: string;
}

const pendingOrigins = new Set<ValueOrigin>(["unknown", "defaulted", "inferred", "saved-preference"]);
const rowDecisionReasons = new Set([
  "Some receipt rows have an unresolved financial role; inspect their retained text.",
  "Check the highlighted receipt row classifications and associations.",
]);
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const requiredItemFields: ItemField[] = ["description", "quantity", "lineTotalCents"];
const requiredReceiptFields: ReceiptField[] = [
  "currency",
  "discountCents",
  "service",
  "gst",
  "gstInclusive",
  "total",
];
const copySource = (source: SourceEvidence): SourceEvidence => ({
  ...source,
  ...(source.lineIndices ? { lineIndices: [...source.lineIndices] } : {}),
  ...(source.boxIndices ? { boxIndices: [...source.boxIndices] } : {}),
});

export function makeEvidence(
  origin: ValueOrigin,
  sources: SourceEvidence[] = [],
  reasons: string[] = [],
): FieldEvidence {
  return {
    origin,
    needsReview: pendingOrigins.has(origin) || reasons.length > 0,
    reasons: [...reasons],
    sources: sources.map(copySource),
  };
}

function pending(evidence: FieldEvidence | undefined): boolean {
  return !evidence || evidence.needsReview || pendingOrigins.has(evidence.origin);
}

/** Row-decision summaries follow current rows; independent source uncertainty remains pending. */
export function rowReviewState(receipt: Receipt): {
  unresolvedRows: boolean;
  independentNeedsReview: boolean;
  evidence: FieldEvidence | undefined;
} {
  const unresolvedRows = !!receipt.rows?.some(row => row.role === "ambiguous" || row.needsReview);
  const existing = receipt.evidence?.rows;
  if (!existing) return { unresolvedRows, independentNeedsReview: false, evidence: undefined };
  const independentReasons = existing.reasons.filter(reason => !rowDecisionReasons.has(reason));
  // A legacy/custom pending flag with no reason has not been resolved merely by classifying rows.
  const independentNeedsReview = pendingOrigins.has(existing.origin) || independentReasons.length > 0
    || (existing.needsReview && existing.reasons.length === 0);
  return {
    unresolvedRows,
    independentNeedsReview,
    evidence: {
      ...existing,
      needsReview: unresolvedRows || independentNeedsReview,
      reasons: [
        ...independentReasons,
        ...(unresolvedRows ? ["Check the highlighted receipt row classifications and associations."] : []),
      ],
    },
  };
}

/** Preserve sources/history while synchronising only the derived row-decision summary. */
export function reconcileRowReviewEvidence(receipt: Receipt): Receipt {
  const state = rowReviewState(receipt);
  return state.evidence ? { ...receipt, evidence: { ...receipt.evidence, rows: state.evidence } } : receipt;
}

function validQuantity(item: ReceiptItem): boolean {
  const q = itemQuantity(item);
  return (
    q !== null &&
    q.numerator !== 0 &&
    (q.numerator > 0 ||
      item.rowKind === "return" ||
      (item.rowKind === "adjustment" && item.pricingContext?.adjustment === "explicit"))
  );
}

/** A legacy display placeholder is not a known quantity. No field is filled here. */
export function effectiveQuantity(item: ReceiptItem): number | null {
  if (
    !validQuantity(item) ||
    !item.evidence?.quantity ||
    item.evidence.quantity.origin === "unknown" ||
    item.evidence.quantity.origin === "defaulted"
  )
    return null;
  return quantityNumber(itemQuantity(item)!);
}

function validItemField(item: ReceiptItem, field: ItemField): boolean {
  switch (field) {
    case "description":
      return !!item.description.trim();
    case "quantity":
      return validQuantity(item);
    case "unitPriceCents":
      return (
        item.unitPriceCents === null ||
        item.unitPriceCents === undefined ||
        isSafeCents(item.unitPriceCents) ||
        ((item.rowKind === "return" ||
          (item.rowKind === "adjustment" && item.pricingContext?.adjustment === "explicit")) &&
          isSafeCents(-item.unitPriceCents))
      );
    case "lineTotalCents":
      return (
        isSafeCents(item.lineTotalCents) ||
        ((item.rowKind === "return" ||
          (item.rowKind === "adjustment" && item.pricingContext?.adjustment === "explicit")) &&
          typeof item.lineTotalCents === "number" &&
          isSafeCents(-item.lineTotalCents))
      );
    case "role":
      return item.rowKind !== "ambiguous";
    case "pricingBasis":
      return (
        !item.priceBasis ||
        (isValidQuantity(item.priceBasis.quantity) &&
          item.priceBasis.quantity.numerator > 0 &&
          !!item.priceBasis.unit.trim())
      );
  }
}

export function itemFieldNeedsReview(item: ReceiptItem, field: ItemField): boolean {
  if (!validItemField(item, field)) return true;
  if (field === "unitPriceCents" && item.unitPriceCents == null) return false;
  if (field === "pricingBasis" && !item.priceBasis && !item.evidence?.pricingBasis?.reasons.length)
    return false;
  const evidence = item.evidence?.[field];
  if (evidence) return pending(evidence);
  if (field === "quantity" || field === "lineTotalCents") return true;
  if (field === "unitPriceCents") return item.unitPriceCents != null;
  if (field === "pricingBasis") return !!item.priceBasis;
  if (field === "role") return item.rowKind === "ambiguous";
  return !!item.flagged;
}

function confirmed(
  previous: FieldEvidence | undefined,
  value: SourceEvidence["observedValue"],
  text: string,
): FieldEvidence {
  const sources = (previous?.sources ?? []).map(copySource);
  const action: SourceEvidence = { kind: "user", observedValue: value, text };
  const last = sources.at(-1);
  // A controlled input reports every keystroke. Keep the latest state of that
  // action instead of turning typing into an unbounded provenance history.
  if (last?.kind === "user" && last.text === text) sources[sources.length - 1] = action;
  else sources.push(action);
  // Never discard recognition/recovery evidence to make room for UI history.
  // Thirty is the UI-history target. Original recognition sources are preserved;
  // storage separately permits up to 600 structured sources for long receipts.
  while (sources.length > 30) {
    const obsoleteUser = sources.findIndex(
      (source, index) => source.kind === "user" && index < sources.length - 1,
    );
    if (obsoleteUser < 0) break;
    sources.splice(obsoleteUser, 1);
  }
  return {
    origin: "user-confirmed",
    needsReview: false,
    reasons: [],
    previousOrigin: previous?.previousOrigin ?? previous?.origin ?? "unknown",
    sources,
  };
}

function itemValue(item: ReceiptItem, field: ItemField): SourceEvidence["observedValue"] {
  if (field === "quantity")
    return item.quantityExact
      ? `${item.quantityExact.numerator}/${item.quantityExact.denominator}`
      : item.quantity;
  if (field === "role") return item.rowKind ?? "product";
  if (field === "pricingBasis")
    return item.priceBasis
      ? `${item.priceBasis.quantity.numerator}/${item.priceBasis.quantity.denominator} ${item.priceBasis.unit}`
      : null;
  return item[field] ?? null;
}

function withItemFlag(item: ReceiptItem): ReceiptItem {
  const fields = [
    ...requiredItemFields,
    ...(item.unitPriceCents != null || item.evidence?.unitPriceCents
      ? ["unitPriceCents" as const]
      : []),
    ...(item.rowKind || item.evidence?.role ? ["role" as const] : []),
    ...(item.priceBasis || item.evidence?.pricingBasis ? ["pricingBasis" as const] : []),
  ];
  return { ...item, flagged: fields.some((field) => itemFieldNeedsReview(item, field)) };
}

/** Confirm only an actual, valid field; unknown quantities cannot be confirmed as the legacy 1. */
export function confirmItemField(item: ReceiptItem, field: ItemField): ReceiptItem {
  if (
    !validItemField(item, field) ||
    (field === "quantity" &&
      (item.quantityExact === null || item.evidence?.quantity?.origin === "unknown"))
  )
    return item;
  const evidence = {
    ...item.evidence,
    [field]: confirmed(
      item.evidence?.[field],
      itemValue(item, field),
      "User confirmed this item field.",
    ),
  };
  return withItemFlag({ ...item, evidence });
}

export function updateItemWithEvidence(
  item: ReceiptItem,
  patch: Partial<ReceiptItem>,
): ReceiptItem {
  let next: ReceiptItem = { ...item, ...patch, evidence: { ...item.evidence } };
  // UI numeric edits are explicit input, not a scanner default. Preserve exact decimals.
  if (own(patch, "quantity") && !own(patch, "quantityExact")) {
    next.quantityExact = parseQuantity(String(patch.quantity));
  }
  const changed: ItemField[] = [];
  if (own(patch, "description") && patch.description !== item.description)
    changed.push("description");
  if (
    (own(patch, "quantity") &&
      (patch.quantity !== item.quantity ||
        JSON.stringify(next.quantityExact) !== JSON.stringify(item.quantityExact))) ||
    (own(patch, "quantityExact") &&
      JSON.stringify(patch.quantityExact) !== JSON.stringify(item.quantityExact))
  )
    changed.push("quantity");
  if (own(patch, "unitPriceCents") && patch.unitPriceCents !== item.unitPriceCents)
    changed.push("unitPriceCents");
  if (own(patch, "lineTotalCents") && patch.lineTotalCents !== item.lineTotalCents)
    changed.push("lineTotalCents");
  if (own(patch, "rowKind") && patch.rowKind !== item.rowKind) changed.push("role");
  if (
    (own(patch, "priceBasis") &&
      JSON.stringify(patch.priceBasis) !== JSON.stringify(item.priceBasis)) ||
    (own(patch, "unitOfMeasure") && patch.unitOfMeasure !== item.unitOfMeasure) ||
    (own(patch, "pricingContext") &&
      JSON.stringify(patch.pricingContext) !== JSON.stringify(item.pricingContext))
  )
    changed.push("pricingBasis");
  for (const field of changed) {
    next.evidence![field] = validItemField(next, field)
      ? confirmed(item.evidence?.[field], itemValue(next, field), "User edited this item field.")
      : {
          ...makeEvidence("unknown", item.evidence?.[field]?.sources, [
            "The edited value is invalid or missing.",
          ]),
          previousOrigin:
            item.evidence?.[field]?.previousOrigin ?? item.evidence?.[field]?.origin ?? "unknown",
        };
  }
  return changed.length ? withItemFlag(next) : { ...next, flagged: item.flagged };
}

const validRate = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_RATE_BP;
function validReceiptField(receipt: Receipt, field: ReceiptField): boolean {
  switch (field) {
    case "currency":
      return receipt.currency === "SGD";
    case "merchant":
      return !!receipt.merchant.trim();
    case "discountCents":
      return isSafeCents(receipt.discountCents);
    case "service":
      return (
        !receipt.serviceEnabled ||
        (receipt.chargeMode === "percentage"
          ? validRate(receipt.serviceRateBp)
          : isSafeCents(receipt.serviceAmountCents))
      );
    case "gst":
      return (
        !receipt.gstEnabled ||
        (receipt.chargeMode === "percentage"
          ? validRate(receipt.gstRateBp)
          : isSafeCents(receipt.gstAmountCents))
      );
    case "serviceRateBp":
      return validRate(receipt.serviceRateBp);
    case "gstRateBp":
      return validRate(receipt.gstRateBp);
    case "gstInclusive":
      return typeof receipt.gstInclusive === "boolean";
    case "total":
      return receipt.receiptTotalCents === null || isSafeSignedCents(receipt.receiptTotalCents);
    case "suggestedTotal":
      return receipt.suggestedTotalCents == null || isSafeSignedCents(receipt.suggestedTotalCents);
    case "rounding":
      return isSafeSignedCents(receipt.roundingAdjustmentCents) && receipt.roundingApplied === true;
    case "rows":
      return !receipt.rows?.some((row) => row.role === "ambiguous" || row.needsReview);
  }
}

function receiptValue(receipt: Receipt, field: ReceiptField): SourceEvidence["observedValue"] {
  if (field === "total") return receipt.receiptTotalCents;
  if (field === "suggestedTotal") return receipt.suggestedTotalCents ?? null;
  if (field === "rounding") return receipt.roundingAdjustmentCents ?? null;
  if (field === "service")
    return receipt.serviceEnabled
      ? receipt.chargeMode === "percentage"
        ? `rate:${receipt.serviceRateBp}`
        : receipt.serviceAmountCents
      : "disabled";
  if (field === "gst")
    return receipt.gstEnabled
      ? receipt.chargeMode === "percentage"
        ? `rate:${receipt.gstRateBp}`
        : receipt.gstAmountCents
      : "disabled";
  if (field === "rows") return "Reviewed row classifications";
  return receipt[field];
}

export function confirmReceiptField(receipt: Receipt, field: ReceiptField): Receipt {
  if (!validReceiptField(receipt, field)) return receipt;
  const text =
    field === "total" && receipt.receiptTotalCents === null
      ? "User confirmed that no printed payable total is available."
      : "User confirmed this receipt field.";
  return {
    ...receipt,
    evidence: {
      ...receipt.evidence,
      [field]: confirmed(receipt.evidence?.[field], receiptValue(receipt, field), text),
    },
  };
}

const receiptFieldKeys: Record<ReceiptField, (keyof Receipt)[]> = {
  currency: ["currency"],
  merchant: ["merchant"],
  discountCents: ["discountCents"],
  service: ["serviceEnabled", "serviceAmountCents"],
  gst: ["gstEnabled", "gstAmountCents"],
  gstInclusive: ["gstInclusive"],
  serviceRateBp: ["serviceRateBp"],
  gstRateBp: ["gstRateBp"],
  total: ["receiptTotalCents"],
  suggestedTotal: ["suggestedTotalCents"],
  rounding: ["roundingAdjustmentCents", "roundingApplied"],
  rows: ["rows"],
};

export function updateReceiptWithEvidence(receipt: Receipt, patch: Partial<Receipt>): Receipt {
  let next: Receipt = { ...receipt, ...patch, evidence: { ...receipt.evidence } };
  for (const [field, keys] of Object.entries(receiptFieldKeys) as [
    ReceiptField,
    (keyof Receipt)[],
  ][]) {
    if (
      !keys.some(
        (key) => own(patch, key) && JSON.stringify(patch[key]) !== JSON.stringify(receipt[key]),
      )
    )
      continue;
    // Individual row actions do not independently confirm unrelated source/layout evidence.
    if (field === "rows") {
      next = reconcileRowReviewEvidence(next);
      continue;
    }
    // Clearing the total input is not confirmation that no printed total exists.
    // Only the explicit confirmation action may establish that absence.
    if (validReceiptField(next, field) && !(field === "total" && next.receiptTotalCents === null))
      next = confirmReceiptField(next, field);
    else
      next.evidence![field] = {
        ...makeEvidence("unknown", receipt.evidence?.[field]?.sources, [
          "The edited value is invalid or missing.",
        ]),
        previousOrigin:
          receipt.evidence?.[field]?.previousOrigin ??
          receipt.evidence?.[field]?.origin ??
          "unknown",
      };
  }
  const changed = (key: keyof Receipt) => own(patch, key) && !Object.is(patch[key], receipt[key]);
  const invalidate = (field: ReceiptField, reason: string) => {
    const previous = next.evidence?.[field];
    next.evidence![field] = {
      ...makeEvidence("unknown", previous?.sources, [reason]),
      previousOrigin: previous?.previousOrigin ?? previous?.origin ?? "unknown",
    };
  };
  const modeChanged = changed("chargeMode");
  for (const charge of ["service", "gst"] as const) {
    const enabledKey = charge === "service" ? "serviceEnabled" : "gstEnabled";
    const amountKey = charge === "service" ? "serviceAmountCents" : "gstAmountCents";
    const rateKey = charge === "service" ? "serviceRateBp" : "gstRateBp";
    if (!next[enabledKey]) continue;
    const reenabled = changed(enabledKey) && !receipt[enabledKey];
    const rateChanged = next.chargeMode === "percentage" && changed(rateKey);
    const taxBasisChanged = charge === "gst" && changed("gstInclusive");
    const explicitValueEdit = next.chargeMode === "receipt" ? changed(amountKey) : changed(rateKey);
    // A mode/rate/enable change is not independent confirmation of a previously
    // stored charge amount or its absence. Keep the unchanged evidence pending.
    if ((modeChanged || reenabled || rateChanged || taxBasisChanged) && !explicitValueEdit)
      invalidate(
        charge,
        "Charge settings changed. Confirm the applicable amount or calculation before splitting.",
      );
    else if (rateChanged)
      invalidate(
        charge,
        "The rate changed. Confirm that this charge calculation applies to the receipt.",
      );
    if (next.chargeMode === "percentage" && (modeChanged || reenabled) && !changed(rateKey))
      invalidate(rateKey, "This rate became applicable again. Confirm it for this receipt.");
    if (charge === "gst" && reenabled && !changed("gstInclusive"))
      invalidate("gstInclusive", "GST was enabled again. Confirm whether it is included or added.");
  }
  return next;
}

const itemMessages: Record<ItemField, string> = {
  description: "Check the product identity.",
  quantity: "Confirm the quantity; a default or unknown quantity is not a confirmed 1.",
  unitPriceCents: "Check the unit price.",
  lineTotalCents: "Check the full line amount.",
  role: "Classify this row as a product, return or adjustment.",
  pricingBasis: "Check the unit and pricing basis.",
};
const receiptMessages: Record<ReceiptField, string> = {
  currency: "Confirm the receipt currency; an application preference is not receipt evidence.",
  merchant: "Check the merchant name.",
  discountCents: "Confirm the receipt discount, including confirmed absence.",
  service: "Confirm the service charge or its absence.",
  gst: "Confirm the GST amount or its absence.",
  gstInclusive: "Confirm whether GST is included or added.",
  total: "Check the printed payable total, or explicitly confirm that it is unavailable.",
  suggestedTotal: "Payment-based total suggestion is not printed-total evidence.",
  rounding: "Check the signed bill-rounding adjustment and apply it only once after checking the receipt.",
  rows: "Resolve ambiguous row classifications.",
  serviceRateBp: "Confirm the service charge rate; a preferred rate is not receipt evidence.",
  gstRateBp: "Confirm the GST rate; a preferred rate is not receipt evidence.",
};

/** Field-specific safety state; this deliberately does not infer values or reconcile amounts. */
export function receiptReviewReasons(receipt: Receipt): ReceiptReviewReason[] {
  const reasons: ReceiptReviewReason[] = [];
  receipt.items.forEach((item, index) => {
    const start = reasons.length;
    for (const field of [
      ...requiredItemFields,
      "unitPriceCents",
      "role",
      "pricingBasis",
    ] as ItemField[]) {
      if (itemFieldNeedsReview(item, field))
        reasons.push({
          path: `items[${index}].${field}`,
          code: !validItemField(item, field) ? "invalid-or-missing" : "unverified",
          message: itemMessages[field],
        });
    }
    if (item.flagged && reasons.length === start)
      reasons.push({
        path: `items[${index}]`,
        code: "legacy-review",
        message: "This product still has an unresolved review flag.",
      });
    for (const message of validatePriceRelationship(item))
      reasons.push({ path: `items[${index}].pricingBasis`, code: "price-relationship", message });
  });
  for (const field of new Set<ReceiptField>([
    ...requiredReceiptFields,
    ...(receipt.evidence?.rounding || receipt.roundingAdjustmentCents !== undefined ? ["rounding" as const] : []),
    ...(receipt.chargeMode === "percentage" && receipt.serviceEnabled
      ? ["serviceRateBp" as const]
      : []),
    ...(receipt.chargeMode === "percentage" && receipt.gstEnabled ? ["gstRateBp" as const] : []),
    ...(["serviceRateBp", "gstRateBp"] as const).filter(field => {
      const evidence = receipt.evidence?.[field];
      return evidence?.needsReview && evidence.sources.some(source => source.kind === "preference")
        && evidence.sources.some(source => source.kind === "text" || source.kind === "geometry");
    }),
    ...(receipt.rows?.length || receipt.evidence?.rows ? ["rows" as const] : []),
  ])) {
    if (field === "gstInclusive" && !receipt.gstEnabled) continue;
    const evidence = field === "rows" ? rowReviewState(receipt).evidence : receipt.evidence?.[field];
    const optionalRowsResolved = field === "rows" && !evidence && validReceiptField(receipt, field);
    const missingTotalUnconfirmed =
      field === "total" &&
      receipt.receiptTotalCents === null &&
      !(
        evidence?.origin === "user-confirmed" &&
        evidence.sources.some((source) => source.kind === "user" && source.observedValue === null)
      );
    if (
      !validReceiptField(receipt, field) ||
      missingTotalUnconfirmed ||
      (!optionalRowsResolved && pending(evidence))
    ) {
      reasons.push({
        path: field,
        code: !validReceiptField(receipt, field) ? "invalid-or-missing" : "unverified",
        message: receiptMessages[field],
      });
    }
  }
  return reasons;
}
