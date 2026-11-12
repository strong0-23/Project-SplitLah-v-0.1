/**
 * Local, dev-only receipt regression page (`npm run receipts:dev`). Files are read into browser
 * memory only; nothing is uploaded, stored or logged, and nothing is saved unless Download is
 * clicked (Download is off in held-out mode).
 *
 * Sources:
 * - Engine scoring (default): photos + verified references, each photo scanned by Tesseract through
 *   the app's own scan pipeline (`scanReceipt`, engine injected), scored by extra correction
 *   actions and silent errors (corrections.ts, comparison.ts). PaddleOCR was compared in Phase 2c
 *   and removed (11 Nov 2026); another engine would be added to `ENGINE_FACTORIES`.
 * - Parser gate (Batch 1b): parser-v2 (baseline) and the rework parser on the SAME text.
 * - Owner references (default): a photos folder (REG001.jpg …) and a verified-references folder
 *   (REG001.owner-inventory-v2.reference.private.json …), paired by REG id, Browser OCR mode.
 *   Every reference must pass the owner's contract or the run is refused.
 * - dataset.json (legacy): the parser-v2 harness format, parser or OCR mode.
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
  type Check,
  type Expected,
  type ParserUnderTest,
  type ScoredReceipt,
  type SummaryScores,
} from "./model";
import { ENGINE_COMPARISON_NAME_MATCH, nameMatchLabel, PARSER_GATE_NAME_MATCH } from "./names";
import { checkReference, pairFiles, toExpected, UNKNOWN_REFERENCE_CREDIT } from "./owner-reference";
import { PARSERS } from "./parsers";
import {
  createTesseractEngine,
  scanReceipt,
  validateImageFile,
  OcrError,
  type OcrEngine,
  type OcrProgress,
} from "../../src/lib/scan";
import {
  cleanTags,
  describeUserAgent,
  ENGINES,
  parseSummaries,
  combinedBlock,
  nameMatchConflict,
  summaryBlock,
  receiptLine,
  type DesktopRun,
  type EngineId,
  type ReceiptEngineResult,
} from "./comparison";
import { runEngineComparison, type EngineCase, type EngineDetail } from "./engine-runner";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const results = $("results");
const summaryBox = $<HTMLTextAreaElement>("summary");
const run = $<HTMLButtonElement>("run");
const cancel = $<HTMLButtonElement>("cancel");
const save = $<HTMLButtonElement>("save");
const copy = $<HTMLButtonElement>("copy");
const source = $<HTMLSelectElement>("source");
const photosDir = $<HTMLInputElement>("photos");
const photosList = $<HTMLInputElement>("photos-files");
const refsDir = $<HTMLInputElement>("references");
const refsList = $<HTMLInputElement>("references-files");
const heldOutBox = $<HTMLInputElement>("heldout");
const warmPicker = $<HTMLSelectElement>("warm");
const engineControls = $("engine-controls");
const baselineBox = $("baseline-box");
const pasted = $<HTMLTextAreaElement>("pasted");
const combine = $<HTMLButtonElement>("combine");
const picker = $<HTMLInputElement>("dataset");
const mode = $<HTMLSelectElement>("mode");
const baselinePicker = $<HTMLInputElement>("baseline");
const revision = $<HTMLInputElement>("revision");
const ownerControls = $("owner-controls");
const legacyControls = $("legacy-controls");
let dataset: ReturnType<typeof datasetSchema.parse> | null = null;
let files = new Map<string, File>();
let baseline: Baseline | null = null;
let controller: AbortController | null = null;
let imageUrls: string[] = [];
/** The last engine run (IDs, counts and timings only), for re-combining with pasted summaries. */
let engineRun: { run: DesktopRun; heldOut: boolean } | null = null;
const heldOut = () => heldOutBox.checked;

/**
 * Photos and references: a folder picker (webkitdirectory) or, in any browser, a plain multi-file
 * picker. Whichever was used last counts.
 */
const lastUsed = new Map<HTMLInputElement, HTMLInputElement>();
for (const [a, b] of [
  [photosDir, photosList],
  [refsDir, refsList],
] as const) {
  a.addEventListener("change", () => lastUsed.set(a, a));
  b.addEventListener("change", () => lastUsed.set(a, b));
}
const filesOf = (dir: HTMLInputElement): File[] => [...(lastUsed.get(dir)?.files ?? [])];
const photoFiles = () => filesOf(photosDir);
const referenceFiles = () => filesOf(refsDir);

/** One receipt to run: the input both parsers read (photo or transcript) and its expected answers. */
interface RunCase {
  id: string;
  expected: Expected;
  input: File;
  image: File | null;
  scanOptions: {
    rotation: null | 0 | 90 | 180 | 270;
    crop: null | { left: number; top: number; right: number; bottom: number };
  };
  /** Extra bytes in the fingerprint (the reference file), so a changed reference isn't compared. */
  referenceText: string | null;
  /** Unscorable known content (counts and codes only). */
  notes: string[];
  /** Sanitised photo-condition tags from the reference (owner references only). */
  tags: string[];
}

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
  notes: string[];
};
type Report = {
  schemaVersion: 1;
  source: "owner-references" | "dataset";
  mode: "ocr" | "parser";
  revision: string;
  createdAt: string;
  userAgent: string;
  complete: boolean;
  setupNotes: string[];
  results: Result[];
};
let report: Report | null = null;
const hash = async (data: BufferSource) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const jsonHash = (value: unknown) => hash(new TextEncoder().encode(JSON.stringify(value)));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fileName = (f: File) => f.webkitRelativePath.split("/").pop() || f.name;

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

/** Held-out mode: one line of IDs and counts per receipt, nothing else. */
function renderLines(lines: string[]) {
  const pre = document.createElement("pre");
  pre.textContent = lines.join("\n");
  results.append(pre);
}

function render(result: Result, c: RunCase) {
  if (heldOut()) {
    renderLines(
      result.error
        ? [`${result.id} | ERROR at ${result.error.stage}`]
        : result.parsers.map((p) => summaryLine(result.id, p.parser, p.scores)),
    );
    return;
  }
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
  if (result.notes.length) {
    const n = document.createElement("p");
    n.textContent = `Not scored: ${result.notes.join("; ")}`;
    article.append(n);
  }
  if (c.image) {
    const d = document.createElement("details");
    const s = document.createElement("summary");
    s.textContent = "Original photo";
    const img = document.createElement("img");
    img.alt = `Photo for ${c.id}`;
    img.src = URL.createObjectURL(c.image);
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
  detail(article, "Scored reference fields (known fields only)", c.expected);
  results.append(article);
}

/** IDs and counts only: this is what the owner sends back. */
function summaryText(r: Report): string {
  const lines = [
    `SplitLah Batch 1b merge gate — source: ${r.source}; mode: ${r.mode}; revision: ${r.revision}; ${r.complete ? "complete" : "PARTIAL"} run, ${r.results.length} receipt(s)`,
    ...r.setupNotes,
  ];
  for (const res of r.results) {
    if (res.error) {
      lines.push(`${res.id} | ERROR at ${res.error.stage}`);
      continue;
    }
    for (const p of res.parsers) lines.push(summaryLine(res.id, p.parser, p.scores));
    if (res.notes.length) lines.push(`${res.id} | not scored: ${res.notes.join("; ")}`);
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

function showSource() {
  const owner = source.value !== "dataset";
  ownerControls.hidden = !owner;
  legacyControls.hidden = owner;
  engineControls.hidden = source.value !== "engine";
  baselineBox.hidden = source.value === "engine";
  run.disabled = controller
    ? true
    : owner
      ? !(photoFiles().length && referenceFiles().length)
      : !dataset;
}
source.onchange = showSource;
heldOutBox.onchange = () => {
  // Nothing shown from an earlier run may stay on screen when switching on held-out mode.
  if (heldOut()) results.replaceChildren();
  save.disabled = heldOut() || !report;
};
const onPicked = () => {
  const p = pairFiles(photoFiles().map(fileName), referenceFiles().map(fileName));
  status.textContent =
    `Paired by REG id: ${p.pairs.map((x) => x.id).join(", ") || "none yet"}.` +
    (p.unpaired.length
      ? `\nUnpaired (not run): ${p.unpaired.map((u) => `${u.id} has no ${u.missing}`).join("; ")}.`
      : "") +
    (p.versionNotes.length ? `\n${p.versionNotes.join("\n")}` : "");
  showSource();
};
for (const el of [photosDir, photosList, refsDir, refsList])
  el.addEventListener("change", () => setTimeout(onPicked));

picker.onchange = async () => {
  dataset = null;
  files = new Map();
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
    status.textContent = `Loaded ${dataset.receipts.length} receipts. Null/omitted answers are unverified.`;
  } catch (e) {
    status.textContent = `Dataset error: ${message(e)}`;
  }
  showSource();
};
baselinePicker.onchange = async () => {
  baseline = null;
  try {
    const f = baselinePicker.files?.[0];
    if (!f) return;
    baseline = baselineSchema.parse(JSON.parse(await f.text()));
    status.textContent = `Earlier report loaded (${baseline.mode}, revision: ${baseline.revision}).`;
  } catch (e) {
    status.textContent = `Earlier report error: ${message(e)}`;
  }
};
cancel.onclick = () => controller?.abort();
/** Clipboard API where allowed; otherwise select the text and use the older copy command. */
async function copyText(box: HTMLTextAreaElement) {
  try {
    await navigator.clipboard.writeText(box.value);
  } catch {
    box.focus();
    box.select();
    document.execCommand("copy");
  }
}
copy.onclick = () => void copyText(summaryBox);
combine.onclick = () => {
  const parsed = parseSummaries(pasted.value);
  summaryBox.value = engineRun
    ? summaryBlock(engineRun.run, engineRun.heldOut, parsed)
    : combinedBlock(parsed);
  copy.disabled = !summaryBox.value;
  const conflict = nameMatchConflict(engineRun ? [engineRun.run, ...parsed.runs] : parsed.runs);
  if (conflict) {
    status.textContent = `Refused: ${conflict}.`;
    return;
  }
  status.textContent = `Combined: ${parsed.runs.length} pasted run(s)${parsed.problems.length ? `, ${parsed.problems.length} unreadable line(s)` : ""}.`;
};

/**
 * Owner references: pair by REG id, read ONLY the paired reference files, validate every one with
 * the contract. Returns null (and explains) if the run must be refused.
 */
async function ownerCases(): Promise<{ cases: RunCase[]; setupNotes: string[] } | null> {
  const photos = new Map(photoFiles().map((f) => [fileName(f), f]));
  const refs = new Map(referenceFiles().map((f) => [fileName(f), f]));
  const p = pairFiles([...photos.keys()], [...refs.keys()]);
  if (!p.pairs.length) {
    status.textContent =
      "Refused: no photo and reference share a REG id (REG001.jpg ↔ REG001.owner-inventory-vN.reference.private.json).";
    return null;
  }
  const failures: string[] = [];
  const cases: RunCase[] = [];
  for (const pair of p.pairs) {
    const text = await refs.get(pair.reference)!.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      failures.push(`${pair.id}: $ not_valid_json`);
      continue;
    }
    const check = checkReference(json, pair.id);
    if (!check.ok) {
      for (const e of check.errors) failures.push(`${pair.id}: ${e.path} ${e.code}`);
      continue;
    }
    const { expected, notes } = toExpected(json);
    const photo = photos.get(pair.photo)!;
    cases.push({
      id: pair.id,
      expected,
      input: photo,
      image: photo,
      scanOptions: { rotation: null, crop: null },
      referenceText: text,
      notes,
      tags: photoTags(json),
    });
  }
  if (failures.length) {
    status.textContent = `Refused: ${failures.length} contract error(s). Fix the reference(s) and run again. Paths and codes only:\n${failures.join("\n")}`;
    return null;
  }
  const setupNotes = [
    `references: ${cases.length} passed the contract; scoring known fields only (unknownReferenceCredit: ${UNKNOWN_REFERENCE_CREDIT})`,
    ...(p.unpaired.length
      ? [`unpaired, not run: ${p.unpaired.map((u) => `${u.id} (no ${u.missing})`).join(", ")}`]
      : []),
    ...p.versionNotes,
  ];
  return { cases, setupNotes };
}

/** The reference's photo-condition tags when known, sanitised to plain words. */
function photoTags(reference: unknown): string[] {
  const field = (reference as { annotation?: { photo_condition_tags?: unknown } } | null)
    ?.annotation?.photo_condition_tags as { state?: unknown; value?: unknown } | undefined;
  return field?.state === "known" ? cleanTags(field.value) : [];
}

function datasetCases(m: "ocr" | "parser"): RunCase[] | null {
  if (!dataset) return null;
  const out: RunCase[] = [];
  for (const r of dataset.receipts) {
    const path = m === "ocr" ? r.image : r.transcript;
    const file = path ? files.get(path) : undefined;
    if (!file) {
      status.textContent = `Missing ${m === "ocr" ? "image" : "verified transcript"} file for ${r.id}.`;
      return null;
    }
    const image = r.image ? (files.get(r.image) ?? null) : null;
    out.push({
      id: r.id,
      expected: r.expected,
      input: file,
      image,
      scanOptions: r.scanOptions,
      referenceText: null,
      notes: [],
      tags: [],
    });
  }
  return out;
}

run.onclick = async () => {
  if (controller) return;
  if (!revision.value.trim()) {
    status.textContent = "Enter a code revision / experiment label for reproducibility.";
    return;
  }
  if (source.value === "engine") return runEngines();
  const owner = source.value === "owner";
  const runMode: "ocr" | "parser" = owner ? "ocr" : (mode.value as "ocr" | "parser");
  const prepared = owner ? await ownerCases() : { cases: datasetCases(runMode), setupNotes: [] };
  if (!prepared || !prepared.cases) return;
  const { cases, setupNotes } = prepared as { cases: RunCase[]; setupNotes: string[] };

  controller = new AbortController();
  const signal = controller.signal;
  const controls = [
    run,
    picker,
    photosDir,
    photosList,
    refsDir,
    refsList,
    source,
    mode,
    revision,
    baselinePicker,
    heldOutBox,
  ];
  for (const el of controls) el.disabled = true;
  cancel.disabled = false;
  save.disabled = true;
  copy.disabled = true;
  imageUrls.forEach((url) => URL.revokeObjectURL(url));
  imageUrls = [];
  results.replaceChildren();
  summaryBox.value = "";
  report = {
    schemaVersion: 1,
    source: owner ? "owner-references" : "dataset",
    mode: runMode,
    revision: revision.value.trim(),
    createdAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    complete: false,
    setupNotes,
    results: [],
  };
  try {
    for (const c of cases) {
      if (signal.aborted) break;
      const start = performance.now();
      const result: Result = {
        id: c.id,
        fingerprint: "",
        durationMs: 0,
        error: null,
        diagnostics: [],
        sourceText: null,
        parsers: [],
        gate: null,
        notes: c.notes,
      };
      let stage = "input";
      try {
        const inputHash = await hash(await c.input.arrayBuffer());
        result.fingerprint = await jsonHash({
          inputHash,
          expected: c.expected,
          reference:
            c.referenceText === null ? null : await hash(new TextEncoder().encode(c.referenceText)),
          scanOptions: runMode === "ocr" ? c.scanOptions : null,
        });
        if (signal.aborted) throw new Error("Cancelled");
        if (runMode === "ocr") {
          const invalid = validateImageFile(c.input);
          if (invalid) throw new Error(invalid);
          stage = "ocr";
          // One OCR reading (the app's own scan path); both parsers then read its text.
          const scanned = await scanReceipt(
            c.input,
            c.scanOptions,
            (p) => {
              result.diagnostics.push({ ...p, elapsedMs: Math.round(performance.now() - start) });
              status.textContent = `${c.id}: ${p.stage} — ${p.status} (${Math.round(p.progress * 100)}%)`;
            },
            signal,
          );
          result.sourceText = scanned.receipt.rawOcrText ?? "";
        } else result.sourceText = await c.input.text();
        stage = "parser";
        for (const parser of PARSERS) {
          const p = parser as unknown as ParserUnderTest;
          const parsed = p.parse(result.sourceText);
          // The Batch 1b gate keeps the exact name rule (its definition must not change).
          const checks = evaluate(c.expected, parsed.receipt, p, {
            nameMatch: PARSER_GATE_NAME_MATCH,
          });
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
          // Held-out mode keeps the stage only: a message could quote receipt content.
          message: heldOut() ? "(hidden in held-out mode)" : message(e),
        };
      }
      result.durationMs = Math.round(performance.now() - start);
      report.results.push(result);
      render(result, c);
    }
    report.complete = !signal.aborted && report.results.length === cases.length;
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
    // Comparison lines name checks (and so products): hidden in held-out mode.
    const changes = heldOut()
      ? "Comparison with an earlier report is hidden in held-out mode."
      : baseline
        ? compare(flat, baseline).join("\n")
        : "No earlier report loaded.";
    status.textContent = `${report.complete ? "Suite finished" : "Suite cancelled (partial report)"}: ${report.results.length}/${cases.length} receipts.\n${changes}`;
  } catch (e) {
    status.textContent = `Harness error: ${message(e)}`;
  } finally {
    controller = null;
    for (const el of controls) el.disabled = false;
    showSource();
    cancel.disabled = true;
    save.disabled = !report || heldOut();
    copy.disabled = !summaryBox.value;
  }
};
save.onclick = () => {
  if (!report || heldOut()) return;
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
  a.download = `receipt-${report.source}-${report.mode}-${report.createdAt.replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// ---------------------------------------------------------------------------------------------
// Engine scoring (Phase 2c tooling, Tesseract only)

/** Stable factories: the engine pool reuses a loaded engine by factory identity. */
const ENGINE_FACTORIES: Record<EngineId, () => OcrEngine> = {
  tesseract: () => createTesseractEngine(),
};

function renderEngineResult(r: ReceiptEngineResult, d: EngineDetail | null) {
  if (heldOut() || !d) return renderLines([receiptLine(r)]);
  const article = document.createElement("article");
  const heading = document.createElement("h2");
  heading.textContent = `${r.id}: ${r.engine}`;
  const line = document.createElement("p");
  line.className = r.status === "ok" ? "pass" : "fail";
  line.textContent = receiptLine(r);
  article.append(heading, line);
  if (d.error) detail(article, "Error", d.error);
  if (d.checks.length)
    scorePanel(article, {
      parser: "rework",
      checks: d.checks,
      scores: summarise(d.checks),
      parsed: d.receipt ? { receipt: d.receipt, warnings: d.warnings } : null,
      totals: null,
    });
  detail(article, "OCR text the parser read", d.text ?? "No text");
  results.append(article);
}

async function runEngines() {
  summaryBox.value = "";
  copy.disabled = true;
  const engines: EngineId[] = [...ENGINES];
  const prepared = await ownerCases();
  if (!prepared) return;
  const cases: EngineCase[] = [];
  for (const c of prepared.cases) {
    const invalid = validateImageFile(c.input);
    if (invalid) {
      status.textContent = `Refused: ${c.id}: the photo is not a supported image${heldOut() ? "" : ` (${invalid})`}.`;
      return;
    }
    cases.push({ id: c.id, image: c.input, expected: c.expected, tags: c.tags });
  }
  const held = heldOut();
  const ua = describeUserAgent(navigator.userAgent);
  const warmRuns = Number(warmPicker.value) || 0;
  controller = new AbortController();
  const signal = controller.signal;
  const controls = [
    run,
    photosDir,
    photosList,
    refsDir,
    refsList,
    source,
    revision,
    heldOutBox,
    warmPicker,
  ];
  for (const el of controls) el.disabled = true;
  cancel.disabled = false;
  save.disabled = true;
  copy.disabled = true;
  report = null;
  engineRun = null;
  results.replaceChildren();
  summaryBox.value = "";
  try {
    const out = await runEngineComparison(
      cases,
      (engine, image, s) =>
        scanReceipt(
          image,
          { rotation: null, crop: null },
          () => undefined,
          s,
          ENGINE_FACTORIES[engine],
        ),
      {
        engines,
        warmRuns,
        heldOut: held,
        nameMatch: ENGINE_COMPARISON_NAME_MATCH,
        signal,
        now: () => performance.now(),
        onProgress: (text) => (status.textContent = text),
        onResult: renderEngineResult,
      },
    );
    const run: DesktopRun = {
      info: {
        set: held ? "held-out" : "development",
        runtime: ua.runtime,
        browser: ua.browser,
        version: ua.version,
        os: ua.os,
        revision: revision.value.trim(),
        engines,
        warmRuns,
        nameMatch: nameMatchLabel(ENGINE_COMPARISON_NAME_MATCH),
        complete: out.complete,
      },
      results: out.results,
    };
    engineRun = { run, heldOut: held };
    summaryBox.value = summaryBlock(run, held, parseSummaries(pasted.value));
    const done = new Set(out.results.map((r) => r.id)).size;
    status.textContent = `${out.complete ? "Engine run finished" : "Engine run cancelled (incomplete)"}: ${done}/${cases.length} receipts.\n${prepared.setupNotes.join("\n")}`;
  } catch {
    status.textContent = "Harness error during the engine run (details hidden).";
  } finally {
    controller = null;
    for (const el of controls) el.disabled = false;
    cancel.disabled = true;
    copy.disabled = !summaryBox.value;
    showSource();
  }
}

showSource();
