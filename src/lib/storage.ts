import { z } from "zod";
import { MAX_CENTS, MAX_QUANTITY, MAX_RATE_BP } from "./money";
import type { ItemAssignment, Participant, Receipt } from "./types";

export const STORAGE_KEY = "splitlah:session";
export const SCHEMA_VERSION = 1;

export type Step = "scan" | "review" | "split" | "summary";

export interface Session {
  receipt: Receipt;
  participants: Participant[];
  assignments: Record<string, ItemAssignment>;
}

const cents = z.number().int().min(0).max(MAX_CENTS);
const text = (max: number) => z.string().max(max);
const id = z.string().min(1).max(64);

const receiptSchema = z.object({
  merchant: text(80),
  currency: z.literal("SGD"),
  items: z.array(z.object({ id, description: text(120), quantity: z.number().int().min(1).max(MAX_QUANTITY), lineTotalCents: cents.nullable(), flagged: z.boolean().optional() })).max(300),
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
  receiptTotalCents: cents.nullable(),
  rawOcrText: text(20000).optional(),
  uncertainFields: z.array(text(40)).max(20).optional(),
  ocrWarnings: z.array(text(300)).max(20).optional(),
});

const sessionSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  receipt: receiptSchema,
  participants: z.array(z.object({ id, name: text(40) })).max(50),
  assignments: z.record(z.object({
    itemId: id,
    mode: z.enum(["single", "even", "quantity", "custom"]),
    participantIds: z.array(id).max(50),
    quantities: z.record(z.number().int().min(0).max(MAX_QUANTITY)),
    amounts: z.record(cents),
  })),
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

export type LoadResult = { status: "ok"; session: Session } | { status: "empty" } | { status: "corrupt" } | { status: "unavailable" };

export function loadSession(): LoadResult {
  const s = store();
  if (!s) return { status: "unavailable" };
  const raw = s.getItem(STORAGE_KEY);
  if (!raw) return { status: "empty" };
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) { s.removeItem(STORAGE_KEY); return { status: "corrupt" }; }
    const { receipt, participants, assignments } = parsed.data;
    return { status: "ok", session: { receipt, participants, assignments } };
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
    s.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, ...session }));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(): void {
  try { store()?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

