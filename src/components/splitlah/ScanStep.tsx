import { useEffect, useRef, useState } from "react";
import { Camera, FileText, ImageUp, Sparkles } from "lucide-react";
import { useBill } from "@/hooks/use-bill";
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES, runOcr, validateImageFile, type OcrProgress } from "@/lib/ocr";
import { parseReceiptText } from "@/lib/parser";
import { Button, Card, Notice } from "./ui";
import { Shell } from "./Shell";

export function ScanStep({ go }: { go: (s: "review" | "split") => void }) {
  const bill = useBill();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const upRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Revoke object URL whenever the preview changes or on unmount. Images live in memory only.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const confirmReplace = () => !bill.hasSession || window.confirm("This replaces your current bill. Continue?");

  const pick = (f: File | undefined) => {
    if (!f) return;
    const err = validateImageFile(f);
    if (err) { setError(err); return; }
    setError(null);
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const scan = async () => {
    if (!file || !confirmReplace()) return;
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const text = await runOcr(file, setProgress, ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!text.trim()) throw new Error("No text was found in this image.");
      const { receipt } = parseReceiptText(text);
      bill.startFromReceipt(receipt);
      setFile(null);
      setPreview(null);
      go("review");
    } catch (e) {
      if (!ctrl.signal.aborted)
        setError(`${e instanceof Error ? e.message : "Scanning failed."} You can try another photo or enter the items manually.`);
    } finally {
      setProgress(null);
    }
  };

  const busy = progress !== null;

  return (
    <Shell step="scan">
      <div className="pt-2">
        <h1 className="text-3xl font-extrabold leading-tight tracking-tight">Split the bill, to the cent.</h1>
        <p className="mt-2 text-muted-foreground">Snap a receipt, check the items, choose who had what. Everything stays on this device.</p>
      </div>

      {bill.notice === "corrupt" && <Notice tone="warning">A saved bill couldn't be read and was cleared.</Notice>}
      {bill.notice === "unavailable" && <Notice tone="warning">Storage is unavailable in this browser, so your bill won't survive a refresh.</Notice>}

      {bill.hasSession && !file && (
        <Card className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Bill in progress</p>
            <p className="truncate font-semibold">{bill.receipt.merchant || "Untitled bill"} · {bill.receipt.items.length} items</p>
          </div>
          <Button variant="secondary" onClick={() => go("review")}>Continue</Button>
        </Card>
      )}

      <input ref={camRef} type="file" accept={ACCEPTED_TYPES.join(",")} capture="environment" className="sr-only" aria-label="Take a photo of the receipt" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      <input ref={upRef} type="file" accept={ACCEPTED_TYPES.join(",")} className="sr-only" aria-label="Upload a receipt image" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />

      {!file ? (
        <Card className="space-y-3">
          <h2 className="font-semibold">Scan receipt</h2>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => camRef.current?.click()}><Camera className="h-5 w-5" aria-hidden /> Camera</Button>
            <Button variant="outline" onClick={() => upRef.current?.click()}><ImageUp className="h-5 w-5" aria-hidden /> Upload</Button>
          </div>
          <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to {MAX_UPLOAD_BYTES / 1048576} MB. Large photos are resized before reading.</p>
        </Card>
      ) : (
        <Card className="space-y-3">
          <h2 className="font-semibold">Receipt photo</h2>
          {preview && <img src={preview} alt="Selected receipt" className="max-h-80 w-full rounded-lg border border-border bg-muted object-contain" />}
          {busy ? (
            <div className="space-y-2" aria-live="polite">
              <div className="flex justify-between text-sm"><span>{progress.status}…</span><span className="money">{Math.round(progress.progress * 100)}%</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.progress * 100)} aria-label="Reading receipt">
                <div className="h-full bg-primary" style={{ width: `${Math.round(progress.progress * 100)}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">First scan downloads the text recogniser (~5 MB). Your photo is not uploaded.</p>
              <Button variant="outline" block onClick={() => abortRef.current?.abort()}>Cancel</Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => upRef.current?.click()}>Replace</Button>
              <Button onClick={scan}>Read receipt</Button>
            </div>
          )}
        </Card>
      )}

      {error && <Notice tone="error">{error}</Notice>}

      <div className="grid gap-2">
        <Button variant="outline" block onClick={() => { if (confirmReplace()) { bill.startManual(); go("review"); } }}>
          <FileText className="h-5 w-5" aria-hidden /> Enter items manually
        </Button>
        <Button variant="ghost" block onClick={() => { if (confirmReplace()) { bill.loadSample(); go("review"); } }}>
          <Sparkles className="h-5 w-5" aria-hidden /> Try sample receipt
        </Button>
      </div>
    </Shell>
  );
}
