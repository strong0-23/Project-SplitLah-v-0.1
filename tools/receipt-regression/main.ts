/**
 * Local, dev-only receipt regression page (`npm run receipts:dev`). Runs parser-v2 (baseline) and
 * the rework parser on the SAME text for each receipt and applies the Batch 1b merge gate.
 * Files are read into browser memory only; nothing is uploaded or saved unless Download is clicked.
 */
import {
  compare,
  datasetSchema,
  baselineSchema,
  evaluate,
  gate,
  summarise,
  summaryLine,
  type Baseline,
  type Case,
  type Check,
  type ParserUnderTest,
  type ScoredReceipt,
  type SummaryScores,
} from "./model";
import { PARSERS } from "./parsers";
import { scanReceipt, validateImageFile, OcrError, type OcrProgress } from "../../src/lib/scan";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const results = $("results");
const summaryBox = $<HTMLTextAreaElement>("summary");
const run = $<HTMLButtonElement>("run");
const cancel = $<HTMLButtonElement>("cancel");
const save = $<HTMLButtonElement>("save");
const copy = $<HTMLButtonElement>("copy");
const picker = $<HTMLInputElement>("dataset");
const mode = $<HTMLSelectElement>("mode");
const baselinePicker = $<HTMLInputElement>("baseline");
const revision = $<HTMLInputElement>("revision");
let dataset: ReturnType<typeof datasetSchema.parse> | null = null;
let files = new Map<string, File>();
let baseline: Baseline | null = null;
let controller: AbortController | null = null;
let imageUrls: string[] = [];

type ParserResult = {
  parser: ParserUnderTest["id"];
  checks: Check[];
  scores: SummaryScores;
  parsed: { receipt: ScoredReceipt; warnings: string[] } | null;
  totals: unknown;
};
type Result = {
  id: string;
  fingerprint: string;
  durationMs: number;
  error: { stage: string; message: string } | null;
  diagnostics: (OcrProgress & { elapsedMs: number })[];
  /** The one text both parsers read (verified transcript, or the rework OCR reading). */
  sourceText: string | null;
  parsers: ParserResult[];
  gate: { worse: string[]; pass: boolean } | null;
};
type Report = {
  schemaVersion: 1;
  mode: "ocr" | "parser";
  revision: string;
  createdAt: string;
  userAgent: string;
  complete: boolean;
  results: Result[];
};
let report: Report | null = null;
const hash = async (data: BufferSource) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const jsonHash = (value: unknown) => hash(new TextEncoder().encode(JSON.stringify(value)));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function detail(parent: HTMLElement, title: string, value: unknown) {
  const d = document.createElement("details");
  const s = document.createElement("summary");
  s.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  d.append(s, pre);
  parent.append(d);
}

function scorePanel(parent: HTMLElement, p: ParserResult) {
  const h = document.createElement("h3");
  h.textContent = p.parser;
  const line = document.createElement("p");
  line.textContent = summaryLine("", p.parser, p.scores).replace(/^ \| /, "");
  const table = document.createElement("table");
  const header = document.createElement("tr");
  for (const text of ["Check", "Status", "Expected", "Actual", "Actual − expected", "Silent?"]) {
    const th = document.createElement("th");
    th.textContent = text;
    header.append(th);
  }
  table.append(header);
  for (const c of p.checks) {
    const row = document.createElement("tr");
    row.className = c.status;
    for (const value of [
      c.key,
      c.status,
      c.expected,
      c.actual,
      c.delta,
      c.silent ? "SILENT" : "",
    ]) {
      const td = document.createElement("td");
      td.textContent = value == null || value === "" ? "—" : String(value);
      row.append(td);
    }
    table.append(row);
  }
  parent.append(h, line, table);
  detail(parent, `${p.parser}: parsed receipt and warnings`, p.parsed);
  detail(parent, `${p.parser}: computed charges and total`, p.totals);
}

function render(result: Result, receipt: Case) {
  const article = document.createElement("article");
  const heading = document.createElement("h2");
  heading.textContent = result.id;
  const verdict = document.createElement("p");
  verdict.className = result.gate?.pass ? "pass" : "fail";
  verdict.textContent = result.error
    ? `ERROR [${result.error.stage}]: ${result.error.message}`
    : result.gate?.pass
      ? `Merge gate: PASS (rework matches or beats parser-v2) — ${result.durationMs} ms`
      : `Merge gate: FAIL — rework is worse on: ${result.gate?.worse.join(", ")}`;
  article.append(heading, verdict);
  const image = receipt.image && files.get(receipt.image);
  if (image) {
    const d = document.createElement("details");
    const s = document.createElement("summary");
    s.textContent = "Original image: verify the reference manually";
    const img = document.createElement("img");
    img.alt = `Reference image for ${receipt.id}`;
    img.src = URL.createObjectURL(image);
    imageUrls.push(img.src);
    d.append(s, img);
    article.append(d);
  }
  for (const p of result.parsers) scorePanel(article, p);
  detail(
    article,
    report?.mode === "ocr" ? "OCR text both parsers read" : "Verified transcript both parsers read",
    result.sourceText ?? "No text",
  );
  detail(article, "OCR stage events", result.diagnostics);
  detail(article, "Manual reference (never generated from OCR)", receipt.expected);
  results.append(article);
}

/** IDs and counts only: this is what the owner sends back. */
function summaryText(r: Report): string {
  const lines = [
    `SplitLah Batch 1b merge gate — mode: ${r.mode}; revision: ${r.revision}; ${r.complete ? "complete" : "PARTIAL"} run, ${r.results.length} receipt(s)`,
  ];
  for (const res of r.results) {
    if (res.error) {
      lines.push(`${res.id} | ERROR at ${res.error.stage}`);
      continue;
    }
    for (const p of res.parsers) lines.push(summaryLine(res.id, p.parser, p.scores));
    lines.push(
      `${res.id} | gate: ${res.gate?.pass ? "PASS" : `FAIL (${res.gate?.worse.join(", ")})`}`,
    );
  }
  const all =
    r.complete && r.results.length > 0 && r.results.every((x) => !x.error && x.gate?.pass);
  lines.push(
    `OVERALL: ${all ? "PASS — rework matches or beats parser-v2 on every receipt" : "FAIL or incomplete"}`,
  );
  return lines.join("\n");
}

picker.onchange = async () => {
  dataset = null;
  files = new Map();
  run.disabled = true;
  save.disabled = true;
  copy.disabled = true;
  report = null;
  try {
    for (const f of [...(picker.files ?? [])]) {
      // Folder picker paths include the selected root folder; strip exactly that prefix.
      files.set(f.webkitRelativePath.split("/").slice(1).join("/"), f);
    }
    const manifest = files.get("dataset.json");
    if (!manifest) throw new Error("Selected folder must contain dataset.json at its root.");
    dataset = datasetSchema.parse(JSON.parse(await manifest.text()));
    status.textContent = `Loaded ${dataset.receipts.length} receipts. Null/omitted answers are unverified. Choose a mode, enter a revision label, then run.`;
    run.disabled = false;
  } catch (e) {
    status.textContent = `Dataset error: ${message(e)}`;
  }
};
baselinePicker.onchange = async () => {
  baseline = null;
  try {
    const f = baselinePicker.files?.[0];
    if (!f) return;
    baseline = baselineSchema.parse(JSON.parse(await f.text()));
    status.textContent = `Baseline loaded (${baseline.mode}, revision: ${baseline.revision}).`;
  } catch (e) {
    status.textContent = `Baseline error: ${message(e)}`;
  }
};
cancel.onclick = () => controller?.abort();
copy.onclick = () => void navigator.clipboard?.writeText(summaryBox.value);

run.onclick = async () => {
  if (!dataset || controller) return;
  if (!revision.value.trim()) {
    status.textContent = "Enter a code revision / experiment label for reproducibility.";
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  for (const element of [run, picker, mode, revision, baselinePicker]) element.disabled = true;
  cancel.disabled = false;
  save.disabled = true;
  copy.disabled = true;
  imageUrls.forEach((url) => URL.revokeObjectURL(url));
  imageUrls = [];
  results.replaceChildren();
  summaryBox.value = "";
  report = {
    schemaVersion: 1,
    mode: mode.value as "ocr" | "parser",
    revision: revision.value.trim(),
    createdAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    complete: false,
    results: [],
  };
  try {
    for (const receipt of dataset.receipts) {
      if (signal.aborted) break;
      const start = performance.now();
      const result: Result = {
        id: receipt.id,
        fingerprint: "",
        durationMs: 0,
        error: null,
        diagnostics: [],
        sourceText: null,
        parsers: [],
        gate: null,
      };
      let stage = "input";
      try {
        const path = report.mode === "ocr" ? receipt.image : receipt.transcript;
        const file = path ? files.get(path) : undefined;
        if (!file)
          throw new Error(
            `Missing ${report.mode === "ocr" ? "image" : "verified transcript"} file for ${receipt.id}.`,
          );
        const inputHash = await hash(await file.arrayBuffer());
        result.fingerprint = await jsonHash({
          inputHash,
          expected: receipt.expected,
          scanOptions: report.mode === "ocr" ? receipt.scanOptions : null,
        });
        if (signal.aborted) throw new Error("Cancelled");
        if (report.mode === "ocr") {
          const invalid = validateImageFile(file);
          if (invalid) throw new Error(invalid);
          stage = "ocr";
          // One OCR reading (the app's own scan path); both parsers then read its text.
          const scanned = await scanReceipt(
            file,
            receipt.scanOptions,
            (p) => {
              result.diagnostics.push({ ...p, elapsedMs: Math.round(performance.now() - start) });
              status.textContent = `${receipt.id}: ${p.stage} — ${p.status} (${Math.round(p.progress * 100)}%)`;
            },
            signal,
          );
          result.sourceText = scanned.receipt.rawOcrText ?? "";
        } else result.sourceText = await file.text();
        stage = "parser";
        for (const parser of PARSERS) {
          const p = parser as unknown as ParserUnderTest;
          const parsed = p.parse(result.sourceText);
          const checks = evaluate(receipt.expected, parsed.receipt, p);
          result.parsers.push({
            parser: p.id,
            checks,
            scores: summarise(checks),
            parsed,
            totals: p.computeTotals(parsed.receipt),
          });
        }
        const v2 = result.parsers.find((p) => p.parser === "parser-v2")!;
        const rw = result.parsers.find((p) => p.parser === "rework")!;
        const worse = gate(rw.scores, v2.scores);
        result.gate = { worse, pass: worse.length === 0 };
      } catch (e) {
        result.error = {
          stage: signal.aborted ? "cancelled" : e instanceof OcrError ? e.stage : stage,
          message: message(e),
        };
      }
      result.durationMs = Math.round(performance.now() - start);
      report.results.push(result);
      render(result, receipt);
    }
    report.complete = !signal.aborted && report.results.length === dataset.receipts.length;
    summaryBox.value = summaryText(report);
    const flat = {
      mode: report.mode,
      results: report.results.flatMap((r) =>
        r.parsers.map((p) => ({
          id: r.id,
          parser: p.parser,
          fingerprint: r.fingerprint,
          checks: p.checks,
          error: r.error,
        })),
      ),
    };
    const changes = baseline ? compare(flat, baseline).join("\n") : "No earlier report loaded.";
    status.textContent = `${report.complete ? "Suite finished" : "Suite cancelled (partial report)"}: ${report.results.length}/${dataset.receipts.length} receipts.\n${changes}`;
  } catch (e) {
    status.textContent = `Harness error: ${message(e)}`;
  } finally {
    controller = null;
    for (const element of [run, picker, mode, revision, baselinePicker]) element.disabled = false;
    cancel.disabled = true;
    save.disabled = !report;
    copy.disabled = !summaryBox.value;
  }
};
save.onclick = () => {
  if (!report) return;
  // The full report holds private receipt text: save it outside Git or in receipt-regression.local/.
  const flat = {
    ...report,
    results: report.results.flatMap((r) =>
      r.parsers.map((p) => ({ ...r, parser: p.parser, checks: p.checks })),
    ),
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(flat, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `receipt-${report.mode}-${report.createdAt.replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
