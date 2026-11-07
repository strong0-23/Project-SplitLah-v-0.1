/** All money values are integer cents. All rates are integer basis points (1% = 100 bp). */
export type Cents = number;
export type BasisPoints = number;

/** Exact quantities; money remains integer cents. No binary-float price multiplication. */
export interface RationalQuantity { numerator: number; denominator: number }
export type ValueOrigin = "observed" | "calculated" | "inferred" | "defaulted" | "saved-preference" | "user-confirmed" | "unknown";
export interface SourceEvidence {
  kind: "text" | "geometry" | "calculation" | "preference" | "user";
  engine?: "text" | "tesseract" | "paddle" | undefined;
  attemptIndex?: number | undefined;
  lineIndices?: number[] | undefined;
  boxIndices?: number[] | undefined;
  text?: string | undefined;
  observedValue?: string | number | boolean | null | undefined;
}
export interface FieldEvidence {
  origin: ValueOrigin;
  needsReview: boolean;
  reasons: string[];
  sources: SourceEvidence[];
  previousOrigin?: ValueOrigin | undefined;
}
export type ItemField = "description" | "quantity" | "unitPriceCents" | "lineTotalCents" | "role" | "pricingBasis";
export type ReceiptField = "currency" | "merchant" | "discountCents" | "service" | "gst" | "serviceRateBp" | "gstRateBp" | "gstInclusive" | "total" | "suggestedTotal" | "rounding" | "rows";
export interface ReceiptRowEvidence {
  id: string;
  role: "product" | "heading" | "adjustment" | "summary" | "payment" | "rounding" | "ambiguous";
  text: string;
  amountCents: Cents | null;
  sources: SourceEvidence[];
  needsReview: boolean;
}

export interface ReceiptItem {
  id: string;
  description: string;
  /** Compatibility/display number. Consult quantityExact and evidence before treating it as known. */
  quantity: number;
  /** null explicitly means unknown; quantity=1 may then be a legacy placeholder only. */
  quantityExact?: RationalQuantity | null | undefined;
  /** Positive layout support only; still defaulted and requires user confirmation. */
  quantityDefaultBasis?: "implicit-layout" | undefined;
  unitOfMeasure?: string | undefined;
  unitPriceCents?: Cents | null | undefined;
  priceBasis?: { quantity: RationalQuantity; unit: string } | undefined;
  rowKind?: "product" | "return" | "adjustment" | "ambiguous" | undefined;
  pricingContext?: { discounts: "none" | "included" | "unresolved"; tax: "compatible" | "unresolved"; adjustment: "none" | "explicit" | "unresolved" } | undefined;
  evidence?: Partial<Record<ItemField, FieldEvidence | undefined>> | undefined;
  /** Line total for the FULL quantity, in cents. null = unknown / not yet entered. */
  lineTotalCents: Cents | null;
  /** Set by the OCR parser when a field looks uncertain. */
  flagged?: boolean | undefined;
}

export type ChargeMode = "percentage" | "receipt";

export interface Receipt {
  merchant: string;
  currency: "SGD";
  items: ReceiptItem[];
  /** Subtotal printed on the receipt (for cross-checking only; never used for billing). */
  printedSubtotalCents: Cents | null;
  /** Printed PRE-TAX subtotal (e.g. "Sales Amount") when item prices include GST. Evidence only. */
  printedNetSubtotalCents?: Cents | null | undefined;
  /** Bill-level discount, distributed proportionally. */
  discountCents: Cents;
  chargeMode: ChargeMode;
  serviceEnabled: boolean;
  serviceRateBp: BasisPoints;
  /** Receipt-mode actual service charge amount. */
  serviceAmountCents: Cents | null;
  gstEnabled: boolean;
  gstRateBp: BasisPoints;
  /** Receipt-mode actual GST amount. */
  gstAmountCents: Cents | null;
  /** Prices already include GST: GST is shown for information only, never added. */
  gstInclusive: boolean;
  /** Grand total printed on the receipt, used for reconciliation. */
  receiptTotalCents: Cents | null;
  rawOcrText?: string | undefined;
  /** Field names the parser was unsure about. */
  uncertainFields?: string[] | undefined;
  /** Human-readable parser warnings. */
  ocrWarnings?: string[] | undefined;
  evidence?: Partial<Record<ReceiptField, FieldEvidence | undefined>> | undefined;
  rows?: ReceiptRowEvidence[] | undefined;
  /** A tender-derived suggestion is never printed-total evidence. */
  suggestedTotalCents?: Cents | null | undefined;
  /** Explicit signed final bill adjustment, applied only when eligible or user-confirmed. */
  roundingAdjustmentCents?: Cents | null | undefined;
  roundingApplied?: boolean | undefined;
  preferencePromptHandled?: boolean | undefined;
  extractionFailure?: { kind: "runtime" | "insufficient"; message: string } | undefined;
}

export interface Participant {
  id: string;
  name: string;
}

export type AssignmentMode = "single" | "even" | "quantity" | "custom";

export interface ItemAssignment {
  itemId: string;
  mode: AssignmentMode;
  /** Used by "single" (exactly one) and "even" (one or more). */
  participantIds: string[];
  /** Used by "quantity": participantId -> whole units. */
  quantities: Record<string, number>;
  /** Used by "custom": participantId -> cents. */
  amounts: Record<string, Cents>;
}

export interface ItemShare {
  itemId: string;
  description: string;
  cents: Cents;
  note: string;
}

export interface ParticipantBill {
  participantId: string;
  name: string;
  items: ItemShare[];
  itemSubtotalCents: Cents;
  discountCents: Cents;
  serviceCents: Cents;
  gstAddedCents: Cents;
  /** Informational GST already included in prices (inclusive mode). */
  gstIncludedCents: Cents;
  roundingCents?: Cents | undefined;
  owedCents: Cents;
}

export interface BillTotals {
  itemSubtotalCents: Cents;
  discountCents: Cents;
  serviceCents: Cents;
  gstAddedCents: Cents;
  gstIncludedCents: Cents;
  unroundedTotalCents?: Cents | undefined;
  roundingCents?: Cents | undefined;
  totalCents: Cents;
  /** receiptTotal - computed total; null when no receipt total entered. */
  mismatchCents: Cents | null;
}

export interface BillCalculation {
  totals: BillTotals;
  participants: ParticipantBill[];
}

