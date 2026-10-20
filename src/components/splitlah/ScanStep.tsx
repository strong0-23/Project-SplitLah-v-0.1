import { useEffect, useRef, useState } from "react";
import { Camera, FileText, ImageUp, RotateCcw, RotateCw, Sparkles } from "lucide-react";
import { useBill } from "@/hooks/use-bill";
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES, OcrCancelled, preparePreview, runOcr, validateImageFile, type OcrProgress, type Rotation, type CropFractions } from "@/lib/ocr";
import { parseReceiptText, scoreParse } from "@/lib/parser";
import { computeTotals } from "@/lib/bill";
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
  const [rotation, setRotation] = useState<Rotation | null>(null);
  const [crop, setCrop] = useState<CropFractions | null>(null);
  const [manualCrop, setManualCrop] = useState(false);

  // Prepared preview: oriented, cropped and lighting-corrected, as the recogniser will see it.
  useEffect(() => {
    if (!file) return;
    let live = true;
    preparePreview(file, { rotation, crop: manualCrop ? crop : null })
      .then((p) => { if (live) { setPreview(URL.createObjectURL(p.blob)); setPreviewRotation(p.rotation); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Couldn't open this image."); });
    return () => { live = false; };
  }, [file, rotation, crop, manualCrop]);
  const [previewRotation, setPreviewRotation] = useState<Rotation>(0);
  const turn = (d: 90 | -90) => setRotation((r) => ((((r ?? previewRotation) + d) % 360 + 360) % 360) as Rotation);

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
    setRotation(null);
    setCrop(null);
    setManualCrop(false);
  };

  const scan = async () => {
    if (!file || abortRef.current || !confirmReplace()) return;
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await runOcr(file, { rotation, crop: manualCrop ? crop : null }, setProgress, ctrl.signal, (t) => {
        const { receipt: r } = parseReceiptText(t);
        const s = scoreParse(r);
        const totals = computeTotals(r);
        return { score: s, good: r.items.length > 0 && r.receiptTotalCents !== null && totals.ok && totals.value.mismatchCents === 0 && !r.uncertainFields?.some((field) => field === "charges" || field === "items" || field === "total") && !r.items.some((i) => i.lineTotalCents === null) };
      });
      if (ctrl.signal.aborted) return;
      const { receipt } = parseReceiptText(res.text);
      if (receipt.items.length === 0) {
        setRotation(res.rotation);
        throw new Error("Text was read but no priced items were found. Rotate or crop the photo to just the receipt and try again.");
      }
      bill.startFromReceipt(receipt);
      setFile(null);
      setPreview(null);
      go("review");
    } catch (e) {
      if (!(e instanceof OcrCancelled) && !ctrl.signal.aborted)
        setError(`${e instanceof Error ? e.message : "Scanning failed."} You can try another photo or enter the items manually.`);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
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
          {!busy && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" onClick={() => turn(-90)} aria-label="Rotate left"><RotateCcw className="h-4 w-4" aria-hidden /></Button>
                <Button variant="outline" onClick={() => turn(90)} aria-label="Rotate right"><RotateCw className="h-4 w-4" aria-hidden /></Button>
                <Button variant="outline" onClick={() => { setManualCrop((m) => !m); setCrop((c) => c ?? { left: 0, top: 0, right: 1, bottom: 1 }); }}>{manualCrop ? "Auto crop" : "Crop"}</Button>
              </div>
              <p className="text-xs text-muted-foreground">{rotation === null ? "Orientation: automatic." : "Orientation set manually."} Make the text upright and crop to the paper if reading fails.</p>
              {manualCrop && crop && (["left", "right", "top", "bottom"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-xs capitalize">
                  <span className="w-14">{k}</span>
                  <input type="range" min={0} max={45} className="flex-1" aria-label={`Crop ${k}`}
                    value={Math.round((k === "left" || k === "top" ? crop[k] : 1 - crop[k]) * 100)}
                    onChange={(e) => { const v = Number(e.target.value) / 100; setCrop({ ...crop, [k]: k === "left" || k === "top" ? v : 1 - v }); }} />
                </label>
              ))}
            </div>
          )}
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

