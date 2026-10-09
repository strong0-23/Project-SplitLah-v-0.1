import { useRef, useState } from "react";
import { Copy, Share2 } from "lucide-react";
import { useBill } from "@/hooks/use-bill";
import { calculateBill } from "@/lib/bill";
import { formatMoney } from "@/lib/money";
import { summaryText } from "@/lib/summary";
import { Button, Card, Notice } from "./ui";
import { Shell } from "./Shell";

export function SummaryStep({ go }: { go: (s: "scan" | "split") => void }) {
  const bill = useBill();
  const calc = calculateBill(bill.receipt, bill.participants, bill.assignments);
  const [status, setStatus] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  if (!calc.ok) {
    return (
      <Shell step="summary" footer={<Button block onClick={() => go("split")}>Back to split</Button>}>
        <Notice tone="error" title="The bill isn't complete yet"><ul className="list-disc pl-4">{calc.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Notice>
      </Shell>
    );
  }
  const c = calc.value;
  const text = summaryText(bill.receipt, c);

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setStatus("Copied — paste it into WhatsApp or Telegram."); }
    catch { setShowText(true); setStatus("Couldn't copy automatically. Select the text below and copy it."); setTimeout(() => textRef.current?.select(), 0); }
  };
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "Splitlah bill", text }); return; }
      catch (e) { if (e instanceof DOMException && e.name === "AbortError") return; }
    }
    await copy();
  };

  return (
    <Shell step="summary" footer={
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={share}><Share2 className="h-5 w-5" aria-hidden /> Share</Button>
          <Button variant="outline" onClick={copy}><Copy className="h-5 w-5" aria-hidden /> Copy</Button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button variant="ghost" onClick={() => go("split")}>Back</Button>
          <Button variant="danger" onClick={() => { if (window.confirm("Start a new bill? This deletes the current bill from this device.")) { bill.reset(); go("scan"); } }}>Start new bill</Button>
        </div>
      </div>
    }>
      <div>
        <p className="text-sm text-muted-foreground">{bill.receipt.merchant || "Bill"}</p>
        <h1 className="money text-4xl font-bold">{formatMoney(c.totals.totalCents)}</h1>
        <p className="text-sm text-muted-foreground">
          Items {formatMoney(c.totals.itemSubtotalCents)}
          {c.totals.discountCents > 0 && ` · discount −${formatMoney(c.totals.discountCents)}`}
          {c.totals.serviceCents > 0 && ` · service ${formatMoney(c.totals.serviceCents)}`}
          {c.totals.gstAddedCents > 0 && ` · GST ${formatMoney(c.totals.gstAddedCents)}`}
          {c.totals.gstIncludedCents > 0 && ` · incl. GST ${formatMoney(c.totals.gstIncludedCents)}`}
        </p>
      </div>
      {status && <Notice tone="success">{status}</Notice>}

      <ul className="space-y-3">
        {c.participants.map((p) => (
          <li key={p.participantId}>
            <Card className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{p.name || "Unnamed"}</h2>
                <p className="money text-xl font-bold text-primary">{formatMoney(p.owedCents)}</p>
              </div>
              {p.items.length === 0 ? <p className="text-sm text-muted-foreground">No items — owes nothing.</p> : (
                <ul className="space-y-0.5 text-sm">
                  {p.items.map((it) => (
                    <li key={it.itemId} className="flex justify-between gap-2">
                      <span>{it.description}{it.note && <span className="text-muted-foreground"> · {it.note}</span>}</span>
                      <span className="money">{formatMoney(it.cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <dl className="grid grid-cols-2 gap-x-3 border-t border-border pt-2 text-xs text-muted-foreground">
                <dt>Item subtotal</dt><dd className="money text-right">{formatMoney(p.itemSubtotalCents)}</dd>
                {c.totals.discountCents > 0 && <><dt>Discount</dt><dd className="money text-right">−{formatMoney(p.discountCents)}</dd></>}
                {c.totals.serviceCents > 0 && <><dt>Service charge</dt><dd className="money text-right">{formatMoney(p.serviceCents)}</dd></>}
                {c.totals.gstAddedCents > 0 && <><dt>GST</dt><dd className="money text-right">{formatMoney(p.gstAddedCents)}</dd></>}
                {c.totals.gstIncludedCents > 0 && <><dt>incl. GST (info)</dt><dd className="money text-right">{formatMoney(p.gstIncludedCents)}</dd></>}
              </dl>
            </Card>
          </li>
        ))}
      </ul>

      <Card>
        <Button variant="ghost" size="sm" aria-expanded={showText} onClick={() => setShowText((s) => !s)}>{showText ? "Hide" : "Show"} text version</Button>
        {showText && <textarea ref={textRef} readOnly aria-label="Bill breakdown text" value={text} className="mt-2 h-64 w-full rounded-lg border border-input bg-muted p-2 font-mono text-xs" />}
      </Card>
    </Shell>
  );
}
