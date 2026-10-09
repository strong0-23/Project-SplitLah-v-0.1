/** All money values are integer cents. All rates are integer basis points (1% = 100 bp). */
export type Cents = number;
export type BasisPoints = number;

export interface ReceiptItem {
  id: string;
  description: string;
  /** Positive integer quantity. */
  quantity: number;
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
  owedCents: Cents;
}

export interface BillTotals {
  itemSubtotalCents: Cents;
  discountCents: Cents;
  serviceCents: Cents;
  gstAddedCents: Cents;
  gstIncludedCents: Cents;
  totalCents: Cents;
  /** receiptTotal - computed total; null when no receipt total entered. */
  mismatchCents: Cents | null;
}

export interface BillCalculation {
  totals: BillTotals;
  participants: ParticipantBill[];
}
