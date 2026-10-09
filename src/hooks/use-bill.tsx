import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { emptyReceipt, sampleSession } from "@/lib/defaults";
import { newId } from "@/lib/ids";
import { clearSession, loadSession, saveSession, type Session } from "@/lib/storage";
import { BillContext as Ctx } from "./bill-context";
import type { ItemAssignment, Participant, Receipt, ReceiptItem } from "@/lib/types";

type Notice = null | "corrupt" | "unavailable" | "save-failed";

export interface BillCtx extends Session {
  ready: boolean;
  notice: Notice;
  hasSession: boolean;
  setReceipt: (fn: (r: Receipt) => Receipt) => void;
  startManual: () => void;
  startFromReceipt: (r: Receipt) => void;
  loadSample: () => void;
  addItem: () => void;
  updateItem: (id: string, patch: Partial<ReceiptItem>) => void;
  removeItem: (id: string) => void;
  addParticipant: (name: string) => void;
  renameParticipant: (id: string, name: string) => void;
  removeParticipant: (id: string) => void;
  setAssignment: (itemId: string, a: ItemAssignment) => void;
  reset: () => void;
}


const blank = (): Session => ({ receipt: emptyReceipt(), participants: [], assignments: {} });

export function sanitizeText(s: string, max: number): string {
  // Strip control chars; React escapes everything else on render.
  return s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

export function BillProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(blank);
  const [hasSession, setHasSession] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const loaded = useRef(false);

  useEffect(() => {
    const res = loadSession();
    if (res.status === "ok") { setSession(res.session); setHasSession(true); }
    else if (res.status === "corrupt" || res.status === "unavailable") setNotice(res.status);
    loaded.current = true;
    setReady(true);
  }, []);

  useEffect(() => {
    if (!loaded.current || !hasSession) return;
    if (!saveSession(session)) setNotice((n) => n ?? "save-failed");
  }, [session, hasSession]);

  const update = useCallback((fn: (s: Session) => Session) => setSession((s) => fn(s)), []);

  const value = useMemo<BillCtx>(() => ({
    ...session,
    ready,
    notice,
    hasSession,
    setReceipt: (fn) => update((s) => ({ ...s, receipt: fn(s.receipt) })),
    startManual: () => {
      const s = blank();
      s.receipt.items = [{ id: newId("i"), description: "", quantity: 1, lineTotalCents: null }];
      setSession(s); setHasSession(true);
    },
    startFromReceipt: (r) => { setSession({ receipt: r, participants: [], assignments: {} }); setHasSession(true); },
    loadSample: () => { setSession(sampleSession()); setHasSession(true); },
    addItem: () => update((s) => ({ ...s, receipt: { ...s.receipt, items: [...s.receipt.items, { id: newId("i"), description: "", quantity: 1, lineTotalCents: null }] } })),
    updateItem: (id, patch) => update((s) => ({
      ...s,
      receipt: { ...s.receipt, items: s.receipt.items.map((it) => (it.id === id ? { ...it, ...patch, flagged: patch.flagged ?? false } : it)) },
    })),
    removeItem: (id) => update((s) => {
      const { [id]: _drop, ...rest } = s.assignments;
      return { ...s, receipt: { ...s.receipt, items: s.receipt.items.filter((i) => i.id !== id) }, assignments: rest };
    }),
    addParticipant: (name) => update((s) => ({ ...s, participants: [...s.participants, { id: newId("p"), name: sanitizeText(name, 40) }] })),
    renameParticipant: (id, name) => update((s) => ({ ...s, participants: s.participants.map((p) => (p.id === id ? { ...p, name: sanitizeText(name, 40) } : p)) })),
    removeParticipant: (id) => update((s) => ({
      ...s,
      participants: s.participants.filter((p: Participant) => p.id !== id),
      assignments: Object.fromEntries(Object.entries(s.assignments).map(([k, a]) => {
        const { [id]: _q, ...quantities } = a.quantities;
        const { [id]: _a, ...amounts } = a.amounts;
        return [k, { ...a, participantIds: a.participantIds.filter((p) => p !== id), quantities, amounts }];
      })),
    })),
    setAssignment: (itemId, a) => update((s) => ({ ...s, assignments: { ...s.assignments, [itemId]: a } })),
    reset: () => { clearSession(); setSession(blank()); setHasSession(false); },
  }), [session, ready, notice, hasSession, update]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBill(): BillCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useBill must be used inside BillProvider");
  return c;
}

export function isAssigned(a: ItemAssignment | undefined, pid: string): boolean {
  if (!a) return false;
  return a.participantIds.includes(pid) || (a.quantities[pid] ?? 0) > 0 || (a.amounts[pid] ?? 0) > 0;
}
