import { formatRate, MAX_RATE_BP } from "./money";
import { makeEvidence } from "./receipt-quality";
import type { Receipt } from "./types";

export const PREFERENCES_KEY = "splitlah.receipt-preferences.v1";
export type PreferenceKey = "currency" | "gstRateBp" | "serviceRateBp";
export interface SavedPreference<T> { value: T; confirmedAt: string }
export interface SavedPreferences {
  schemaVersion: 1;
  currency?: SavedPreference<"SGD">;
  gstRateBp?: SavedPreference<number>;
  serviceRateBp?: SavedPreference<number>;
}
export interface PreferenceCandidate { key: PreferenceKey; label: string; value: "SGD" | number; valueLabel: string }
export interface PreferenceConflict {
  key: PreferenceKey;
  label: string;
  receiptValue: "SGD" | number;
  receiptValueLabel: string;
  savedValue: "SGD" | number;
  savedValueLabel: string;
}
export interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const keys: PreferenceKey[] = ["currency", "gstRateBp", "serviceRateBp"];
const validRate = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RATE_BP;
const labels = { currency: "Currency", gstRateBp: "GST rate", serviceRateBp: "Service-charge rate" };
const preferenceLabel = (key: PreferenceKey, value: "SGD" | number) => key === "currency" ? String(value) : `${formatRate(value as number)}%`;

/** Conflicts are inspected independently from whether a rate is currently used for billing. */
export function savedPreferenceConflicts(receipt: Receipt): PreferenceConflict[] {
  return keys.flatMap(key => {
    const evidence = receipt.evidence?.[key];
    if (!evidence || evidence.origin === "user-confirmed") return [];
    const current = receipt[key];
    const source = evidence.sources.find(source => source.kind === "preference" && source.observedValue !== current &&
      (key === "currency" ? source.observedValue === "SGD" : validRate(source.observedValue)));
    if (!source) return [];
    const value = source.observedValue as "SGD" | number;
    return [{ key, label: labels[key], receiptValue: current, receiptValueLabel: preferenceLabel(key, current),
      savedValue: value, savedValueLabel: preferenceLabel(key, value) }];
  });
}

/** A previous confirmation of another field or another value is not permission to save this one. */
export function eligiblePreferenceValues(receipt: Receipt): PreferenceCandidate[] {
  return keys.flatMap(key => {
    const evidence = receipt.evidence?.[key];
    const value = receipt[key];
    if (evidence?.origin !== "user-confirmed" || evidence.needsReview || evidence.reasons.length ||
      !evidence.sources.some(source => source.kind === "user" && source.observedValue === value) ||
      (key === "currency" ? value !== "SGD" : !validRate(value))) return [];
    return [{ key, label: labels[key], value, valueLabel: preferenceLabel(key, value) }];
  });
}

export function mergeConfirmedPreferences(receipt: Receipt, selected: readonly PreferenceKey[], previous: SavedPreferences | null,
  confirmedAt: string): { preferences: SavedPreferences; savedKeys: PreferenceKey[] } {
  const preferences: SavedPreferences = { ...(previous ?? {}), schemaVersion: 1 };
  const eligible = eligiblePreferenceValues(receipt);
  const savedKeys: PreferenceKey[] = [];
  for (const key of [...new Set(selected)]) {
    const candidate = eligible.find(value => value.key === key);
    if (!candidate) continue;
    if (key === "currency") preferences.currency = { value: "SGD", confirmedAt };
    else preferences[key] = { value: candidate.value as number, confirmedAt };
    savedKeys.push(key);
  }
  return { preferences, savedKeys };
}

function browserStorage(): PreferenceStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
function cleanPreferences(value: unknown): SavedPreferences | null {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return null;
  const source = value as Record<string, unknown>;
  const result: SavedPreferences = { schemaVersion: 1 };
  for (const key of keys) {
    const raw = source[key];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry["confirmedAt"] !== "string" || !Number.isFinite(Date.parse(entry["confirmedAt"]))) continue;
    if (key === "currency") {
      if (entry["value"] === "SGD") result.currency = { value: "SGD", confirmedAt: entry["confirmedAt"] };
    } else if (validRate(entry["value"])) result[key] = { value: entry["value"], confirmedAt: entry["confirmedAt"] };
  }
  return result;
}
export function loadSavedPreferences(storage: PreferenceStorage | null = browserStorage()): SavedPreferences | null {
  try { const text = storage?.getItem(PREFERENCES_KEY); return text ? cleanPreferences(JSON.parse(text)) : null; } catch { return null; }
}
/** Only this tiny allowlisted schema is persisted; receipt sources and content never enter this store. */
export function writeSavedPreferences(preferences: SavedPreferences, storage: PreferenceStorage | null = browserStorage()): boolean {
  try { const clean = cleanPreferences(preferences); if (!storage || !clean) return false; storage.setItem(PREFERENCES_KEY, JSON.stringify(clean)); return true; } catch { return false; }
}

export function applySavedPreferences(receipt: Receipt, preferences: SavedPreferences | null): Receipt {
  if (!preferences) return receipt;
  let next = receipt;
  for (const key of keys) {
    const saved = preferences[key];
    if (!saved) continue;
    const evidence = receipt.evidence?.[key];
    const source = { kind: "preference" as const, observedValue: saved.value, text: `${labels[key]} saved after user confirmation on ${saved.confirmedAt}.` };
    if (evidence && (evidence.origin === "observed" || evidence.origin === "inferred") && receipt[key] !== saved.value) {
      const reason = `Saved preference differs from receipt evidence: ${labels[key]} ${preferenceLabel(key, saved.value)} saved; ${preferenceLabel(key, receipt[key])} on this receipt. Confirm the receipt value individually.`;
      const sources = evidence.sources.some(previous => previous.kind === "preference" && previous.observedValue === saved.value && previous.text === source.text)
        ? evidence.sources : [...evidence.sources, source];
      next = { ...next, evidence: { ...next.evidence, [key]: { ...evidence, needsReview: true,
        sources, reasons: [...new Set([...evidence.reasons, reason])] } } };
      continue;
    }
    // Any captured or inferred receipt evidence wins over a preference, including conflicting evidence.
    if (evidence && (!["unknown", "defaulted", "saved-preference"].includes(evidence.origin) ||
      evidence.sources.some(source => source.kind !== "preference"))) continue;
    next = { ...next, [key]: saved.value, evidence: { ...next.evidence,
      [key]: makeEvidence("saved-preference", [source], [`Saved preference only. Confirm that this ${labels[key].toLowerCase()} applies to this receipt.`]) } };
  }
  return next;
}
