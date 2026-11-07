import { datasetSchema, baselineSchema, evaluate, compare, type Baseline, type Case, type Check } from "./model";
import { runOcr, validateImageFile, OcrError, type OcrProgress, type OcrResult } from "../../src/lib/ocr";
import { parseReceiptText } from "../../src/lib/parser";
import { parseOcrResult } from "../../src/lib/receipt-reading";
import { scoreOcrText } from "../../src/lib/scan-score";
import { computeTotals } from "../../src/lib/bill";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const results = $("results");
const run = $<HTMLButtonElement>("run");
const cancel = $<HTMLButtonElement>("cancel");
const save = $<HTMLButtonElement>("save");
const picker = $<HTMLInputElement>("dataset");
const mode = $<HTMLSelectElement>("mode");
const baselinePicker = $<HTMLInputElement>("baseline");
const revision = $<HTMLInputElement>("revision");
let dataset: ReturnType<typeof datasetSchema.parse> | null = null;
let files = new Map<string, File>();
let baseline: Baseline | null = null;
let controller: AbortController | null = null;
let imageUrls: string[] = [];
type Result = {
  id: string; fingerprint: string; durationMs: number; checks: Check[];
  error: { stage: string; message: string } | null;
  diagnostics: (OcrProgress & { elapsedMs: number })[];
  ocr: OcrResult | null;
  sourceText: string | null;
  parsed: ReturnType<typeof parseOcrResult> | null;
  totals: ReturnType<typeof computeTotals> | null;
  review: { flaggedItemCount: number; uncertainFields: string[]; automaticAcceptance: boolean } | null;
};
type Report = { schemaVersion: 1; mode: "ocr" | "parser"; revision: string; createdAt: string; userAgent: string; complete: boolean; results: Result[] };
let report: Report | null = null;
const hash = async (data: BufferSource) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const jsonHash = (value: unknown) => hash(new TextEncoder().encode(JSON.stringify(value)));
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function detail(parent: HTMLElement, title: string, value: unknown) {
  const d = document.createElement("details");
  const s = document.createElement("summary"); s.textContent = title;
  const pre = document.createElement("pre"); pre.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  d.append(s, pre); parent.append(d);
}
function render(result: Result, receipt: Case) {
  const article = document.createElement("article");
  const heading = document.createElement("h2"); heading.textContent = result.id; article.append(heading);
  const summary = document.createElement("p");
  const count = (s: string) => result.checks.filter((c) => c.status === s).length;
  summary.textContent = `${result.durationMs} ms | ${count("pass")} passed / ${count("fail")} failed / ${count("unknown")} unverified${result.error ? ` | ERROR [${result.error.stage}]: ${result.error.message}` : ""}`;
  article.append(summary);
  if (result.review) {
    const review = document.createElement("p");
    review.textContent = `Review: ${result.review.flaggedItemCount} flagged item(s). ${result.review.automaticAcceptance ? "Scanner acceptance checks passed." : "Manual review remains required."} Passing reference checks does not clear review flags.`;
    article.append(review);
  }
  const image = receipt.image && files.get(receipt.image);
  if (image) {
    const d = document.createElement("details"); const s = document.createElement("summary"); s.textContent = "Original image: verify the reference manually";
    const img = document.createElement("img"); img.alt = `Reference image for ${receipt.id}`; img.src = URL.createObjectURL(image); imageUrls.push(img.src);
    d.append(s, img); article.append(d);
  }
  const table = document.createElement("table");
  const header = document.createElement("tr");
  for (const text of ["Check", "Status", "Expected", "Actual", "Actual − expected"]) { const th = document.createElement("th"); th.textContent = text; header.append(th); }
  table.append(header);
  for (const c of result.checks) {
    const row = document.createElement("tr"); row.className = c.status;
    for (const value of [c.key, c.status, c.expected, c.actual, c.delta]) { const td = document.createElement("td"); td.textContent = value == null ? "—" : String(value); row.append(td); }
    table.append(row);
  }
  article.append(table);
  detail(article, report?.mode === "ocr" ? "OCR output (before parsing)" : "Verified transcript input (OCR not run)", result.sourceText ?? "No text returned");
  detail(article, "Parsed output and warnings", result.parsed);
  detail(article, "Computed charges and total", result.totals);
  detail(article, "OCR stage events, rotation, crop and passes", { events: result.diagnostics, result: result.ocr ? { rotation: result.ocr.rotation, crop: result.ocr.crop, passes: result.ocr.passes } : null });
  if (result.ocr?.attempts) detail(article, "OCR candidates (selected attempt is zero-based)", { selectedAttempt: result.ocr.selectedAttempt, attempts: result.ocr.attempts });
  if (result.ocr?.itemReadings?.length) detail(article, "Targeted item-region OCR and source geometry", result.ocr.itemReadings);
  detail(article, "Manual reference (never generated from OCR)", receipt.expected);
  results.append(article);
}
picker.onchange = async () => {
  dataset = null; files = new Map(); run.disabled = true; save.disabled = true; report = null;
  try {
    const selected = [...(picker.files ?? [])];
    // Folder picker paths include the selected root folder; strip exactly that prefix.
    for (const f of selected) { const path = f.webkitRelativePath.split("/").slice(1).join("/"); files.set(path, f); }
    const manifest = files.get("dataset.json");
    if (!manifest) throw new Error("Selected folder must contain dataset.json at its root.");
    dataset = datasetSchema.parse(JSON.parse(await manifest.text()));
    status.textContent = `Loaded ${dataset.receipts.length} receipts. Null/omitted answers are unverified. Choose a mode, enter a revision label, then run.`;
    run.disabled = false;
  } catch (e) { status.textContent = `Dataset error: ${message(e)}`; }
};
baselinePicker.onchange = async () => {
  baseline = null;
  try {
    const f = baselinePicker.files?.[0]; if (!f) return;
    baseline = baselineSchema.parse(JSON.parse(await f.text()));
    status.textContent = `Baseline loaded (${baseline.mode}, revision: ${baseline.revision}).`;
  } catch (e) { status.textContent = `Baseline error: ${message(e)}`; }
};
cancel.onclick = () => controller?.abort();
run.onclick = async () => {
  if (!dataset || controller) return;
  if (!revision.value.trim()) { status.textContent = "Enter a code revision / experiment label for reproducibility."; return; }
  controller = new AbortController();
  const signal = controller.signal;
  for (const element of [run, picker, mode, revision, baselinePicker]) element.disabled = true;
  cancel.disabled = false; save.disabled = true;
  imageUrls.forEach((url) => URL.revokeObjectURL(url)); imageUrls = []; results.replaceChildren();
  report = { schemaVersion: 1, mode: mode.value as "ocr" | "parser", revision: revision.value.trim(), createdAt: new Date().toISOString(), userAgent: navigator.userAgent, complete: false, results: [] };
  try {
    for (const receipt of dataset.receipts) {
      if (signal.aborted) break;
      const start = performance.now();
      const result: Result = { id: receipt.id, fingerprint: "", durationMs: 0, checks: [], error: null, diagnostics: [], ocr: null, sourceText: null, parsed: null, totals: null, review: null };
      let stage = "input";
      try {
        const path = report.mode === "ocr" ? receipt.image : receipt.transcript;
        const file = path ? files.get(path) : undefined;
        if (!file) throw new Error(`Missing ${report.mode === "ocr" ? "image" : "verified transcript"} file for ${receipt.id}.`);
        const inputHash = await hash(await file.arrayBuffer());
        result.fingerprint = await jsonHash({ inputHash, expected: receipt.expected, scanOptions: report.mode === "ocr" ? receipt.scanOptions : null });
        if (signal.aborted) throw new Error("Cancelled");
        if (report.mode === "ocr") {
          const invalid = validateImageFile(file); if (invalid) throw new Error(invalid);
          stage = "ocr";
          result.ocr = await runOcr(file, receipt.scanOptions, (p) => {
            result.diagnostics.push({ ...p, elapsedMs: Math.round(performance.now() - start) });
            status.textContent = `${receipt.id}: ${p.stage} — ${p.status} (${Math.round(p.progress * 100)}%)`;
          }, signal, scoreOcrText);
          result.sourceText = result.ocr.text;
        } else result.sourceText = await file.text();
        stage = "parser";
        result.parsed = result.ocr ? parseOcrResult(result.ocr) : parseReceiptText(result.sourceText);
        result.totals = computeTotals(result.parsed.receipt);
        result.review = {
          flaggedItemCount: result.parsed.receipt.items.filter((item) => item.flagged).length,
          uncertainFields: result.parsed.receipt.uncertainFields ?? [],
          automaticAcceptance: scoreOcrText(result.sourceText).good,
        };
      } catch (e) {
        result.error = { stage: signal.aborted ? "cancelled" : e instanceof OcrError ? e.stage : stage, message: message(e) };
      }
      result.checks = evaluate(receipt.expected, result.parsed?.receipt ?? null);
      result.durationMs = Math.round(performance.now() - start);
      report.results.push(result); render(result, receipt);
    }
    report.complete = !signal.aborted && report.results.length === dataset.receipts.length;
    const changes = baseline ? compare(report, baseline).join("\n") : "No baseline loaded. Download this report to establish one.";
    status.textContent = `${report.complete ? "Suite finished" : "Suite cancelled (partial report)"}: ${report.results.length}/${dataset.receipts.length} receipts.\n${changes}\nCompare OCR text against the photo/transcript before attributing a mismatch to OCR or parsing.`;
  } catch (e) { status.textContent = `Harness error: ${message(e)}`; }
  finally {
    controller = null;
    for (const element of [run, picker, mode, revision, baselinePicker]) element.disabled = false;
    cancel.disabled = true; save.disabled = !report;
  }
};
save.onclick = () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `receipt-${report.mode}-${report.createdAt.replace(/[:.]/g, "-")}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
