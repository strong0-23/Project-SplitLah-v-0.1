import { z } from "zod";
import { MAX_CENTS, MAX_QUANTITY, MAX_RATE_BP } from "./money";
import type { ItemAssignment, Participant, Receipt } from "./types";

export const STORAGE_KEY = "splitlah:session";
export const SCHEMA_VERSION = 2;

export type Step = "scan" | "review" | "split" | "summary";

export interface Session {
  receipt: Receipt;
  participants: Participant[];
  assignments: Record<string, ItemAssignment>;
}

const cents = z.number().int().min(0).max(MAX_CENTS);
const text = (max: number) => z.string().max(max);
const id = z.string().min(1).max(64);
const signedCents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS);
const rational = z
  .object({
    numerator: z.number().int().safe(),
    denominator: z.number().int().min(1).max(1_000_000),
  })
  .refine(
    (q) => q.numerator !== 0 && Math.abs(q.numerator) <= MAX_QUANTITY * q.denominator,
    "Invalid exact quantity",
  );
const origin = z.enum([
  "observed",
  "calculated",
  "inferred",
  "defaulted",
  "saved-preference",
  "user-confirmed",
  "unknown",
]);
const source = z.object({
  kind: z.enum(["text", "geometry", "calculation", "preference", "user"]),
  engine: z.enum(["text", "tesseract", "paddle"]).optional(),
  attemptIndex: z.number().int().min(0).max(100).optional(),
  lineIndices: z.array(z.number().int().min(0)).max(300).optional(),
  boxIndices: z.array(z.number().int().min(0)).max(300).optional(),
  text: text(1000).optional(),
  observedValue: z.union([text(1000), z.number().finite(), z.boolean(), z.null()]).optional(),
});
const evidence = z.object({
  origin,
  needsReview: z.boolean(),
  reasons: z.array(text(300)).max(30),
  sources: z.array(source).max(600),
  previousOrigin: origin.optional(),
});
const itemEvidence = z.object({
  description: evidence.optional(),
  quantity: evidence.optional(),
  unitPriceCents: evidence.optional(),
  lineTotalCents: evidence.optional(),
  role: evidence.optional(),
  pricingBasis: evidence.optional(),
});
const receiptEvidence = z.object({
  currency: evidence.optional(),
  merchant: evidence.optional(),
  discountCents: evidence.optional(),
  service: evidence.optional(),
  gst: evidence.optional(),
  serviceRateBp: evidence.optional(),
  gstRateBp: evidence.optional(),
  gstInclusive: evidence.optional(),
  total: evidence.optional(),
  suggestedTotal: evidence.optional(),
  rounding: evidence.optional(),
  rows: evidence.optional(),
});

const receiptSchema = z.object({
  merchant: text(80),
  currency: z.literal("SGD"),
  items: z
    .array(
      z.object({
        id,
        description: text(120),
        quantity: z.number().finite().min(-MAX_QUANTITY).max(MAX_QUANTITY),
        quantityExact: rational.nullable().optional(),
        quantityDefaultBasis: z.literal("implicit-layout").optional(),
        unitOfMeasure: text(30).optional(),
        unitPriceCents: signedCents.nullable().optional(),
        priceBasis: z.object({ quantity: rational, unit: text(30) }).optional(),
        rowKind: z.enum(["product", "return", "adjustment", "ambiguous"]).optional(),
        pricingContext: z
          .object({
            discounts: z.enum(["none", "included", "unresolved"]),
            tax: z.enum(["compatible", "unresolved"]),
            adjustment: z.enum(["none", "explicit", "unresolved"]),
          })
          .optional(),
        evidence: itemEvidence.optional(),
        lineTotalCents: signedCents.nullable(),
        flagged: z.boolean().optional(),
      }),
    )
    .max(300),
  printedSubtotalCents: cents.nullable(),
  printedNetSubtotalCents: cents.nullable().optional(),
  discountCents: cents,
  chargeMode: z.enum(["percentage", "receipt"]),
  serviceEnabled: z.boolean(),
  serviceRateBp: z.number().int().min(0).max(MAX_RATE_BP),
  serviceAmountCents: cents.nullable(),
  gstEnabled: z.boolean(),
  gstRateBp: z.number().int().min(0).max(MAX_RATE_BP),
  gstAmountCents: cents.nullable(),
  gstInclusive: z.boolean(),
  receiptTotalCents: signedCents.nullable(),
  rawOcrText: text(20000).optional(),
  uncertainFields: z.array(text(40)).max(20).optional(),
  ocrWarnings: z.array(text(300)).max(20).optional(),
  evidence: receiptEvidence.optional(),
  rows: z
    .array(
      z.object({
        id,
        role: z.enum(["product", "heading", "adjustment", "summary", "payment", "rounding", "ambiguous"]),
        text: text(1000),
        amountCents: signedCents.nullable(),
        sources: z.array(source).max(600),
        needsReview: z.boolean(),
      }),
    )
    .max(400)
    .optional(),
  suggestedTotalCents: signedCents.nullable().optional(),
  roundingAdjustmentCents: signedCents.nullable().optional(),
  roundingApplied: z.boolean().optional(),
  preferencePromptHandled: z.boolean().optional(),
  extractionFailure: z
    .object({ kind: z.enum(["runtime", "insufficient"]), message: text(500) })
    .optional(),
});

const sessionSchema = z.object({
  version: z.union([z.literal(1), z.literal(SCHEMA_VERSION)]),
  receipt: receiptSchema,
  participants: z.array(z.object({ id, name: text(40) })).max(50),
  assignments: z.record(
    z.object({
      itemId: id,
      mode: z.enum(["single", "even", "quantity", "custom"]),
      participantIds: z.array(id).max(50),
      quantities: z.record(z.number().int().min(0).max(MAX_QUANTITY)),
      amounts: z.record(signedCents),
    }),
  ),
});

function store(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    const k = "__splitlah_probe";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export type LoadResult =
  | { status: "ok"; session: Session }
  | { status: "empty" }
  | { status: "corrupt" }
  | { status: "unavailable" };

export function loadSession(): LoadResult {
  const s = store();
  if (!s) return { status: "unavailable" };
  const raw = s.getItem(STORAGE_KEY);
  if (!raw) return { status: "empty" };
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      s.removeItem(STORAGE_KEY);
      return { status: "corrupt" };
    }
    const { receipt, participants, assignments } = parsed.data;
    return {
      status: "ok",
      session: {
        receipt: parsed.data.version === 1 ? migrateLegacyReceipt(receipt) : receipt,
        participants,
        assignments,
      },
    };
  } catch {
    s.removeItem(STORAGE_KEY);
    return { status: "corrupt" };
  }
}

/** Persists structured data only — images are never stored. */
export function saveSession(session: Session): boolean {
  const s = store();
  if (!s) return false;
  try {
    const validated = sessionSchema.safeParse({ version: SCHEMA_VERSION, ...session });
    if (!validated.success) return false;
    s.setItem(STORAGE_KEY, JSON.stringify(validated.data));
    return true;
  } catch {
    return false;
  }
}

/** Old stored values have no reliable provenance; keep them, require field review. */
export function migrateLegacyReceipt(receipt: Receipt): Receipt {
  const pending = (): import("./types").FieldEvidence => ({
    origin: "unknown",
    needsReview: true,
    reasons: ["Saved value predates field provenance; please verify this field."],
    sources: [],
  });
  return {
    ...receipt,
    items: receipt.items.map((item) => ({
      ...item,
      flagged: true,
      quantityExact: null,
      evidence: {
        description: pending(),
        quantity: pending(),
        lineTotalCents: pending(),
        ...(item.evidence ?? {}),
      },
    })),
    evidence: {
      currency: pending(),
      discountCents: pending(),
      service: pending(),
      gst: pending(),
      gstInclusive: pending(),
      total: pending(),
      ...(receipt.evidence ?? {}),
    },
  };
}

export function clearSession(): void {
  try {
    store()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
