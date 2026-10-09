import { useState } from "react";
import { Minus, Plus, Trash2, UserPlus } from "lucide-react";
import { isAssigned, useBill } from "@/hooks/use-bill";
import { allocateItem, calculateBill, type AllocationState } from "@/lib/bill";
import { formatMoney } from "@/lib/money";
import type { AssignmentMode, ItemAssignment, ReceiptItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button, Card, MoneyInput, Notice, Segmented } from "./ui";
import { Shell } from "./Shell";

const STATE_STYLE: Record<AllocationState, string> = {
  complete: "bg-success text-success-foreground",
  partial: "bg-warning text-warning-foreground",
  unassigned: "bg-warning text-warning-foreground",
  over: "bg-destructive/10 text-destructive",
  invalid: "bg-destructive/10 text-destructive",
};

function People() {
  const { participants, assignments, addParticipant, renameParticipant, removeParticipant } = useBill();
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n) return;
    addParticipant(n);
    setName("");
  };
  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">People</h2>
      <ul className="space-y-2">
        {participants.map((p, i) => (
          <li key={p.id} className="flex gap-2">
            <input aria-label={`Name of person ${i + 1}`} className="field-input" value={p.name} maxLength={40} onChange={(e) => renameParticipant(p.id, e.target.value)} />
            <Button variant="danger" size="icon" aria-label={`Remove ${p.name || `person ${i + 1}`}`} onClick={() => {
              const used = Object.values(assignments).some((a) => isAssigned(a, p.id));
              if (used && !window.confirm(`${p.name || "This person"} is assigned to items. Removing them will clear those assignments. Continue?`)) return;
              removeParticipant(p.id);
            }}><Trash2 className="h-5 w-5" /></Button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input aria-label="New person's name" className="field-input" placeholder="Add a name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="secondary" aria-label="Add person" disabled={!name.trim()}><UserPlus className="h-5 w-5" /> Add</Button>
      </form>
    </Card>
  );
}

function blankAssignment(itemId: string, mode: AssignmentMode, prev?: ItemAssignment): ItemAssignment {
  const keep = prev?.mode === "single" || prev?.mode === "even" ? prev.participantIds : [];
  return { itemId, mode, participantIds: mode === "single" ? keep.slice(0, 1) : keep, quantities: {}, amounts: {} };
}

function ItemAssign({ item }: { item: ReceiptItem }) {
  const { participants, assignments, setAssignment } = useBill();
  const a = assignments[item.id];
  const mode = a?.mode ?? "single";
  const alloc = allocateItem(item, a, participants);
  const cur = a ?? blankAssignment(item.id, mode);

  const toggle = (pid: string) => {
    if (mode === "single") setAssignment(item.id, { ...cur, mode, participantIds: cur.participantIds[0] === pid ? [] : [pid] });
    else {
      const has = cur.participantIds.includes(pid);
      setAssignment(item.id, { ...cur, mode, participantIds: has ? cur.participantIds.filter((x) => x !== pid) : [...cur.participantIds, pid] });
    }
  };
  const modes: { value: AssignmentMode; label: string }[] = [
    { value: "single", label: "One" },
    { value: "even", label: "Even" },
    ...(item.quantity > 1 ? [{ value: "quantity" as const, label: "By qty" }] : []),
    { value: "custom", label: "Custom $" },
  ];

  return (
    <li className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{item.description || "Untitled item"}</p>
          <p className="text-xs text-muted-foreground">Qty {item.quantity} · <span className="money">{formatMoney(item.lineTotalCents ?? 0)}</span> total</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", STATE_STYLE[alloc.state])}>
          {alloc.state === "complete" ? "Done" : alloc.state === "unassigned" ? "Unassigned" : alloc.state === "partial" ? `${formatMoney(alloc.remainingCents)} left` : alloc.state === "over" ? "Over" : "Fix"}
        </span>
      </div>
      <Segmented label={`Split method for ${item.description}`} value={mode} options={modes} onChange={(m) => setAssignment(item.id, blankAssignment(item.id, m, a))} />

      {participants.length === 0 && <p className="text-sm text-muted-foreground">Add people above first.</p>}

      {(mode === "single" || mode === "even") && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="People">
          {participants.map((p) => {
            const on = cur.participantIds.includes(p.id);
            return (
              <button key={p.id} type="button" aria-pressed={on} onClick={() => toggle(p.id)}
                className={cn("min-h-11 rounded-full border px-4 text-sm font-medium", on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-card")}>
                {p.name || "Unnamed"}{on && alloc.state === "complete" && <span className="money ml-1 opacity-80">{formatMoney(alloc.shares[p.id] ?? 0, "$")}</span>}
              </button>
            );
          })}
        </div>
      )}

      {mode === "quantity" && (
        <ul className="space-y-2">
          {participants.map((p) => {
            const q = cur.quantities[p.id] ?? 0;
            const setQ = (n: number) => setAssignment(item.id, { ...cur, mode, quantities: { ...cur.quantities, [p.id]: Math.max(0, Math.min(item.quantity, n)) } });
            return (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">{p.name || "Unnamed"}</span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" aria-label={`One less for ${p.name}`} disabled={q === 0} onClick={() => setQ(q - 1)}><Minus className="h-4 w-4" /></Button>
                  <span className="money w-8 text-center" aria-live="polite">{q}</span>
                  <Button variant="outline" size="icon" aria-label={`One more for ${p.name}`} disabled={alloc.allocatedQty >= item.quantity} onClick={() => setQ(q + 1)}><Plus className="h-4 w-4" /></Button>
                </div>
              </li>
            );
          })}
          <p className="text-xs text-muted-foreground">{alloc.allocatedQty} of {item.quantity} allocated</p>
        </ul>
      )}

      {mode === "custom" && (
        <div className="space-y-2">
          {participants.map((p) => (
            <MoneyInput key={p.id} compact label={p.name || "Unnamed"} value={cur.amounts[p.id] ?? null}
              onChange={(c) => {
                const amounts = { ...cur.amounts };
                if (c === null) delete amounts[p.id]; else amounts[p.id] = c;
                setAssignment(item.id, { ...cur, mode, amounts });
              }} />
          ))}
          <p className="text-xs text-muted-foreground">Entered {formatMoney(alloc.allocatedCents)} of {formatMoney(item.lineTotalCents ?? 0)}</p>
        </div>
      )}
      {alloc.state !== "complete" && alloc.state !== "unassigned" && <p className="text-xs text-destructive">{alloc.message}</p>}
    </li>
  );
}

export function SplitStep({ go }: { go: (s: "review" | "summary") => void }) {
  const { receipt, participants, assignments } = useBill();
  const calc = calculateBill(receipt, participants, assignments);
  const pending = receipt.items.filter((it) => allocateItem(it, assignments[it.id], participants).state !== "complete");
  const unassignedCents = pending.reduce((s, it) => s + allocateItem(it, assignments[it.id], participants).remainingCents, 0);

  return (
    <Shell step="split" footer={
      <div className="space-y-2">
        {pending.length > 0 && <p className="text-center text-sm text-warning-foreground"><span className="money">{formatMoney(unassignedCents)}</span> across {pending.length} item{pending.length > 1 ? "s" : ""} still to allocate</p>}
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button variant="outline" onClick={() => go("review")}>Back</Button>
          <Button disabled={!calc.ok} onClick={() => go("summary")}>See summary</Button>
        </div>
      </div>
    }>
      <h1 className="text-2xl font-bold">Who had what?</h1>
      <People />
      <Card className="space-y-3">
        <h2 className="font-semibold">Items</h2>
        <ul className="space-y-3">{receipt.items.map((it) => <ItemAssign key={it.id} item={it} />)}</ul>
      </Card>
      {!calc.ok && (
        <Notice tone="warning" title="Before you can finish">
          <ul className="list-disc pl-4">{calc.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul>
        </Notice>
      )}
    </Shell>
  );
}
