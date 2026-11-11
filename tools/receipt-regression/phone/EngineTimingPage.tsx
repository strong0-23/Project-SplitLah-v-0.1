/**
 * Phone timing page (Phase 2c, rules c and d). Dev-only: reached through the app route
 * `/dev/engine-timing`, which answers "not found" unless the dev engine switch is compiled in
 * (`npm run dev`, or a preview build with VITE_SPLITLAH_ENGINE_SWITCH=on; never `main`).
 *
 * The owner picks an engine and a receipt photo; the page runs 1 first (cold) scan and 3 warm
 * re-scans through the app's own scan pipeline and shows the median warm time, the device's user
 * agent and a one-line result to copy. With an optional verified reference it also counts the extra
 * corrections and silent errors (rule d). It never shows, stores or logs receipt content: no
 * preview, no OCR text, no field values; nothing is uploaded.
 */
import { useRef, useState } from "react";
import {
  createTesseractEngine,
  engineFactoryFor,
  scanReceipt,
  validateImageFile,
  type OcrEngine,
} from "../../../src/lib/scan";
import {
  cleanId,
  clean,
  ENGINE_LABEL,
  MAX_WARM_MS,
  median,
  phoneLine,
  withFailures,
  type EngineId,
  type PhoneResult,
} from "../comparison";
import { runEngineComparison } from "../engine-runner";
import type { Expected } from "../model";
import { checkReference, PHOTO_FILE, REFERENCE_FILE, toExpected } from "../owner-reference";

const WARM_RUNS = 3;
const FACTORIES: Record<EngineId, (() => OcrEngine) | undefined> = {
  tesseract: () => createTesseractEngine(),
  paddle: engineFactoryFor("?engine=paddle"),
};
const secs = (ms: number | null) =>
  ms === null ? "–" : ms === Infinity ? "failed" : `${(ms / 1000).toFixed(1)} s`;

export function EngineTimingPage() {
  const [engine, setEngine] = useState<EngineId>("paddle");
  const [locked, setLocked] = useState<EngineId | null>(null);
  const [label, setLabel] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [receiptId, setReceiptId] = useState("");
  const [expected, setExpected] = useState<Expected | null>(null);
  const [refNote, setRefNote] = useState("No reference: timing only (rule c).");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<PhoneResult | null>(null);
  const [running, setRunning] = useState(false);
  const scansThisSession = useRef(0);
  const out = useRef<HTMLTextAreaElement>(null);

  const pickPhoto = (f: File | null) => {
    setPhoto(f);
    setResult(null);
    const m = f ? PHOTO_FILE.exec(f.name) : null;
    if (m) setReceiptId(m[1]!.toUpperCase());
  };

  const pickReference = async (f: File | null) => {
    setExpected(null);
    setResult(null);
    if (!f) return setRefNote("No reference: timing only (rule c).");
    const m = REFERENCE_FILE.exec(f.name);
    const id = m ? m[1]!.toUpperCase() : cleanId(receiptId);
    let json: unknown;
    try {
      json = JSON.parse(await f.text());
    } catch {
      return setRefNote("Reference refused: not valid JSON.");
    }
    const check = checkReference(json, id || "REG000");
    if (!check.ok)
      return setRefNote(
        `Reference refused (paths and codes only): ${check.errors.map((e) => `${e.path} ${e.code}`).join("; ")}`,
      );
    setExpected(toExpected(json).expected);
    if (m) setReceiptId(id);
    setRefNote(`Reference for ${id} accepted: corrections will be counted (rule d).`);
  };

  const run = async () => {
    if (!photo || running) return;
    const invalid = validateImageFile(photo);
    if (invalid) return setProgress(invalid);
    const factory = FACTORIES[engine];
    if (!factory) return setProgress("Paddle is not available in this build.");
    setRunning(true);
    setLocked(engine);
    setResult(null);
    const firstKind = scansThisSession.current === 0 ? "cold" : "repeat";
    const id = cleanId(receiptId) || "photo";
    try {
      const { results } = await runEngineComparison(
        [{ id, image: photo, expected }],
        (_e, image, signal) =>
          scanReceipt(image, { rotation: null, crop: null }, () => undefined, signal, factory),
        {
          engines: [engine],
          warmRuns: WARM_RUNS,
          heldOut: true,
          signal: new AbortController().signal,
          now: () => performance.now(),
          onProgress: (text) => setProgress(text.replace(/^[^:]*: /, "")),
        },
      );
      scansThisSession.current += 1;
      const r = results[0]!;
      setResult({
        phone: clean(label, 120) || clean(navigator.userAgent, 120),
        engine,
        id,
        status: r.status === "ok" ? "ok" : "failed",
        stage: r.stage,
        firstKind,
        firstMs: r.firstMs,
        warmMs: r.warmMs,
        corrections: r.corrections?.total ?? null,
        silent: r.silent,
        userAgent: navigator.userAgent,
      });
      setProgress(r.status === "ok" ? "Done." : `The scan failed at: ${r.stage ?? "unknown"}.`);
    } finally {
      setRunning(false);
    }
  };

  const copy = async () => {
    const box = out.current;
    if (!box) return;
    try {
      await navigator.clipboard.writeText(box.value);
      setProgress("Copied.");
    } catch {
      box.focus();
      box.select();
      document.execCommand("copy");
      setProgress("Copied (or select the text and copy it).");
    }
  };

  const warm = result ? median(withFailures(result.warmMs)) : null;
  const field = "mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4 text-foreground">
      <h1 className="text-xl font-semibold">Engine timing (developer page)</h1>
      <p className="text-sm text-muted-foreground">
        For the engine comparison only. Runs 1 first scan and {WARM_RUNS} warm re-scans of one photo
        on this phone. The photo stays on the phone; no receipt content is shown or kept. For a true
        cold first scan, clear this site's data (or use a private tab) before the first photo, and
        use one page load per engine.
      </p>
      <label className="block text-sm font-medium">
        Engine
        <select
          className={field}
          value={locked ?? engine}
          disabled={!!locked || running}
          onChange={(e) => setEngine(e.target.value as EngineId)}
        >
          <option value="paddle">PaddleOCR</option>
          <option value="tesseract">Tesseract</option>
        </select>
      </label>
      {locked && (
        <p className="text-xs text-muted-foreground">
          Engine fixed for this page session. Reload the page to switch engine.
        </p>
      )}
      <label className="block text-sm font-medium">
        Phone label (e.g. the model; the same label for every run on this phone)
        <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Receipt photo (REG001.jpg …)
        <input
          className={field}
          type="file"
          accept="image/*"
          disabled={running}
          onChange={(e) => pickPhoto(e.target.files?.[0] ?? null)}
        />
      </label>
      <label className="block text-sm font-medium">
        Receipt ID
        <input
          className={field}
          value={receiptId}
          placeholder="REG001"
          onChange={(e) =>
            setReceiptId(
              e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 12),
            )
          }
        />
      </label>
      {receiptId && !cleanId(receiptId) && (
        <p className="text-xs text-destructive">
          Use the receipt&apos;s ID, letters then digits (e.g. REG007), so phone results can be
          matched across engines.
        </p>
      )}
      <label className="block text-sm font-medium">
        Verified reference (optional, for rule d)
        <input
          className={field}
          type="file"
          accept=".json,application/json"
          disabled={running}
          onChange={(e) => void pickReference(e.target.files?.[0] ?? null)}
        />
      </label>
      <p className="text-xs text-muted-foreground">{refNote}</p>
      <button
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        disabled={!photo || running}
        onClick={() => void run()}
      >
        {running ? "Scanning…" : `Run 1 + ${WARM_RUNS} scans with ${ENGINE_LABEL[engine]}`}
      </button>
      <p role="status" className="text-sm">
        {progress}
      </p>
      {result && (
        <section className="space-y-2 rounded-md border p-3 text-sm">
          <p>
            First scan ({result.firstKind === "cold" ? "cold" : "not cold: second photo"}):{" "}
            {secs(result.firstMs)}
          </p>
          <p>Warm scans: {result.warmMs.map((x) => secs(x)).join(", ") || "–"}</p>
          <p className="font-semibold">
            Median warm: {secs(warm)}{" "}
            {result.engine === "paddle" && warm !== null
              ? warm <= MAX_WARM_MS
                ? "(within 8 s)"
                : "(over 8 s)"
              : ""}
          </p>
          <p>
            Extra corrections: {result.corrections ?? "not scored"}; silent errors:{" "}
            {result.silent ?? "not scored"}
          </p>
          <p className="break-all text-xs text-muted-foreground">Device: {result.userAgent}</p>
          <textarea
            ref={out}
            readOnly
            className="h-28 w-full rounded-md border p-2 font-mono text-xs"
            value={phoneLine(result)}
          />
          <button className="rounded-md border px-3 py-1" onClick={() => void copy()}>
            Copy result
          </button>
        </section>
      )}
    </main>
  );
}
