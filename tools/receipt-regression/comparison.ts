/**
 * Engine scoring (Phase 2c tooling, single-engine since 11 Nov 2026): per-receipt results, the
 * shareable summary (receipt IDs and counts only), and pasting summaries from other browsers.
 * Pure.
 *
 * The Phase 2c comparison is finished: PaddleOCR did not replace Tesseract and was removed
 * (docs/DECISIONS.md, 11 Nov 2026). Its decision rule (a)-(d), the 70% stop rule and the phone
 * lines are gone with it. What stays is the scoring: extra correction actions (corrections.ts),
 * silent financial errors, within-2 shares, failures and first/warm timings per run, so Tesseract
 * (and the parser behind it) can be measured on the development and future held-out sets. An
 * engine added later goes in `ENGINES`, and its rows appear next to Tesseract's.
 *
 * - Failed and timed-out scans stay in the denominators (they are not within 2 corrections, and a
 *   failed timing counts as infinitely slow in a median).
 * - Every run line names its item-name rule (`name-match=`, names.ts). Summaries scored with
 *   different rules are never combined: a run line without the field predates the rule and was
 *   scored `exact`.
 * - Summaries from before the removal that name `paddle` are reported as unreadable lines.
 */
import { MAX_CORRECTIONS, type Corrections } from "./corrections";
import { coverageShare, type Coverage } from "./coverage";

export type EngineId = "tesseract";
export const ENGINES: readonly EngineId[] = ["tesseract"];
export const ENGINE_LABEL: Record<EngineId, string> = { tesseract: "Tesseract" };

/** One receipt scanned by one engine. IDs, counts and timings only: never receipt content. */
export interface ReceiptEngineResult {
  id: string;
  engine: EngineId;
  status: "ok" | "failed" | "cancelled";
  /** Stage of a failure (decode, load, orient, recognize, timeout, input, parse). */
  stage?: string | undefined;
  /** null when not scored (failed scan, or no verified reference). */
  corrections: Corrections | null;
  silent: number | null;
  /** First scan of this image in this run (the session's cold scan for the first receipt). */
  firstMs: number | null;
  /** Warm re-scans; null = that re-scan failed or timed out. */
  warmMs: Array<number | null>;
  /** Did every warm re-scan read the same text as the first scan? null when no warm runs. */
  stable: boolean | null;
  /** The owner's photo-condition tags for this receipt (sanitised words), for the breakdown. */
  tags?: string[] | undefined;
  /**
   * Reading coverage of the first scan (coverage.ts): how many of the reference's printed amounts
   * appear in the OCR text. A count only; null/absent when not measured.
   */
  coverage?: Coverage | null | undefined;
  /** Did the review screen warn that the photo was only partly read (D14)? Absent: not measured. */
  incomplete?: boolean | undefined;
}

export interface RunInfo {
  set: "held-out" | "development";
  runtime: "desktop" | "mobile";
  browser: string;
  version: string;
  os: string;
  revision: string;
  engines: EngineId[];
  warmRuns: number;
  /** Item-name rule used for scoring, as `nameMatchLabel` writes it (e.g. "recognisable-0.70"). */
  nameMatch: string;
  complete: boolean;
}

export interface DesktopRun {
  info: RunInfo;
  results: ReceiptEngineResult[];
}

// ---------------------------------------------------------------------------------------------
// Small helpers

/** Median; an Infinity (failed run) counts as the slowest value. Empty → null. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Timings with failed runs as Infinity, so failures stay in the denominator. */
export const withFailures = (xs: ReadonlyArray<number | null>) =>
  xs.map((x) => (x === null ? Infinity : x));

export function warmMedian(r: Pick<ReceiptEngineResult, "status" | "warmMs">): number | null {
  if (!r.warmMs.length) return r.status === "ok" ? null : Infinity;
  return median(withFailures(r.warmMs));
}

export const withinLimit = (r: ReceiptEngineResult) =>
  r.status === "ok" && r.corrections !== null && r.corrections.total <= MAX_CORRECTIONS;

const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(1)}%` : "n/a");
export const share = (k: number, n: number) => `${k}/${n} (${pct(k, n)})`;
const secs = (ms: number | null) =>
  ms === null ? "n/a" : ms === Infinity ? "failed" : `${(ms / 1000).toFixed(1)} s`;

/** Browser, version, OS and desktop/mobile from a user-agent string. */
export function describeUserAgent(
  ua: string,
): Pick<RunInfo, "browser" | "version" | "os" | "runtime"> {
  const pick = (re: RegExp) => re.exec(ua)?.[1] ?? "";
  let browser = "Other";
  let version = "";
  if (/Edg(?:e|A|iOS)?\//.test(ua))
    [browser, version] = ["Edge", pick(/Edg(?:e|A|iOS)?\/([\d.]+)/)];
  else if (/Firefox\/|FxiOS\//.test(ua))
    [browser, version] = ["Firefox", pick(/(?:Firefox|FxiOS)\/([\d.]+)/)];
  else if (/OPR\//.test(ua)) [browser, version] = ["Opera", pick(/OPR\/([\d.]+)/)];
  else if (/SamsungBrowser\//.test(ua))
    [browser, version] = ["Samsung Internet", pick(/SamsungBrowser\/([\d.]+)/)];
  else if (/Chrome\/|CriOS\//.test(ua))
    [browser, version] = ["Chrome", pick(/(?:Chrome|CriOS)\/([\d.]+)/)];
  else if (/Safari\//.test(ua)) [browser, version] = ["Safari", pick(/Version\/([\d.]+)/)];
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux|X11/.test(ua)
            ? "Linux"
            : "Other";
  const runtime = /Mobi|Android|iPhone|iPad|iPod/.test(ua) ? "mobile" : "desktop";
  return { browser, version: version || "unknown", os, runtime };
}

/** Field values in summary lines: no separators, no line breaks, bounded length. */
export const clean = (s: string, max = 200) =>
  s
    .replace(/[|=\r\n\t]/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
/**
 * Receipt IDs: a short letter prefix and digits (REG001), nothing else, so no free text can ride
 * along in an ID. Anything else gives "" (unreadable).
 */
export function cleanId(s: string): string {
  const id = s.trim().toUpperCase();
  return /^[A-Z]{1,6}\d{1,6}$/.test(id) ? id : "";
}
/**
 * Photo-condition tags from the owner's reference (`annotation.photo_condition_tags`, known only):
 * lowercase words of letters, digits, `_` and `-`, at most 8 tags of 24 characters. Anything else is
 * dropped, so no free text reaches a summary.
 */
export function cleanTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;]/) : [];
  const out = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const tag = t.trim().toLowerCase().replace(/\s+/g, "_");
    if (/^[a-z0-9_-]{1,24}$/.test(tag)) out.add(tag);
  }
  return [...out].slice(0, 8);
}
/** Name-match labels (names.ts `nameMatchLabel`): short lowercase words, digits, dots, dashes. */
export const cleanNameMatch = (s: string) => (/^[a-z0-9.-]{1,30}$/.test(s) ? s : "");
/** Summaries written before the `name-match` field existed were scored with the exact rule. */
export const LEGACY_NAME_MATCH = "exact";
/** Failure stages are short lowercase words (decode, load, orient, recognize, timeout …). */
export const cleanStage = (s: string) => (/^[a-z]{1,12}$/.test(s) ? s : "other");

// ---------------------------------------------------------------------------------------------
// Summary lines (machine-readable; only `run` and `receipt` lines are read back)

export const SUMMARY_HEADER = "SPLITLAH ENGINE COMPARISON v1 (receipt IDs and counts only)";
const ms = (x: number | null) => (x === null ? "-" : String(Math.round(x)));
const msList = (xs: ReadonlyArray<number | null>) => (xs.length ? xs.map(ms).join(",") : "-");

export function runLine(i: RunInfo, receipts: number): string {
  return [
    "run",
    `set=${i.set}`,
    `runtime=${i.runtime}`,
    `browser=${clean(i.browser, 40)}`,
    `version=${clean(i.version, 40)}`,
    `os=${clean(i.os, 40)}`,
    `revision=${clean(i.revision, 60) || "-"}`,
    `engines=${i.engines.join(",")}`,
    `warm-runs=${i.warmRuns}`,
    "condition=first-use",
    `name-match=${cleanNameMatch(i.nameMatch) || "-"}`,
    `complete=${i.complete ? "yes" : "no"}`,
    `receipts=${receipts}`,
  ].join(" | ");
}

export function receiptLine(r: ReceiptEngineResult): string {
  return [
    "receipt",
    `id=${cleanId(r.id)}`,
    `engine=${r.engine}`,
    `status=${r.status}`,
    ...(r.stage ? [`stage=${cleanStage(r.stage)}`] : []),
    `corrections=${r.corrections ? r.corrections.total : "-"}`,
    `silent=${r.silent ?? "-"}`,
    `first-ms=${ms(r.firstMs)}`,
    `warm-ms=${msList(r.warmMs)}`,
    `stable=${r.stable === null ? "-" : r.stable ? "yes" : "no"}`,
    `tags=${r.tags?.length ? cleanTags(r.tags).join(",") || "-" : "-"}`,
    `coverage=${r.coverage ? `${r.coverage.found}/${r.coverage.of}` : "-"}`,
    `incomplete=${r.incomplete === undefined ? "-" : r.incomplete ? "yes" : "no"}`,
  ].join(" | ");
}

/** `found/of` from a summary line; null when absent or malformed. */
function coverageOf(v: string | undefined): Coverage | null {
  const m = /^(\d{1,4})\/(\d{1,4})$/.exec(v ?? "");
  if (!m) return null;
  const found = Number(m[1]);
  const of = Number(m[2]);
  return found <= of ? { found, of } : null;
}

/** Per-receipt field breakdown: development runs only (held-out runs show aggregates only). */
export function detailLine(r: ReceiptEngineResult): string | null {
  if (!r.corrections) return null;
  const c = r.corrections;
  return `detail | id=${cleanId(r.id)} | engine=${r.engine} | missing=${c.missing} | extra=${c.extra} | quantity=${c.quantity} | amount=${c.amount} | charges=${c.charges} | printed-total=${c.printedTotal}`;
}

function fields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of line.split(" | ").slice(1)) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}
const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "-" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const numList = (v: string | undefined) =>
  !v || v === "-" ? [] : v.split(",").map((x) => num(x.trim()));
const engineOf = (v: string | undefined): EngineId | null => ENGINES.find((e) => e === v) ?? null;

export interface Parsed {
  runs: DesktopRun[];
  /** Problems found while reading (line numbers and reasons, no content). */
  problems: string[];
}

/**
 * Reads summary blocks (from this or another browser). Only the structured `run` and `receipt`
 * lines are read; all other lines (headers, aggregates) are ignored and recomputed. Each `run` line
 * starts a new run; `receipt` lines belong to the run above.
 */
export function parseSummaries(text: string): Parsed {
  const out: Parsed = { runs: [], problems: [] };
  let current: DesktopRun | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const kind = line.split(" | ")[0];
    const f = fields(line);
    const where = `line ${index + 1}`;
    if (kind === "run") {
      const engines = (f.get("engines") ?? "").split(",").map(engineOf);
      const set = f.get("set");
      const runtime = f.get("runtime");
      const nameMatch = cleanNameMatch(f.get("name-match") ?? LEGACY_NAME_MATCH);
      if (
        (set !== "held-out" && set !== "development") ||
        (runtime !== "desktop" && runtime !== "mobile") ||
        engines.some((e) => e === null) ||
        !nameMatch
      ) {
        out.problems.push(`${where}: unreadable run line`);
        current = null;
        return;
      }
      current = {
        info: {
          set,
          runtime,
          browser: clean(f.get("browser") ?? "Other", 40),
          version: clean(f.get("version") ?? "unknown", 40),
          os: clean(f.get("os") ?? "Other", 40),
          revision: clean(f.get("revision") ?? "-", 60),
          engines: engines as EngineId[],
          warmRuns: num(f.get("warm-runs")) ?? 0,
          nameMatch,
          complete: f.get("complete") === "yes",
        },
        results: [],
      };
      out.runs.push(current);
    } else if (kind === "receipt") {
      const engine = engineOf(f.get("engine"));
      const status = f.get("status");
      const id = cleanId(f.get("id") ?? "");
      if (
        !current ||
        !engine ||
        !id ||
        (status !== "ok" && status !== "failed" && status !== "cancelled")
      ) {
        out.problems.push(
          `${where}: unreadable receipt line${current ? "" : " (no run line above it)"}`,
        );
        return;
      }
      const total = num(f.get("corrections"));
      const stable = f.get("stable");
      current.results.push({
        id,
        engine,
        status,
        stage: f.get("stage") ? cleanStage(f.get("stage")!) : undefined,
        // Pasted lines carry the total only; the breakdown stays with the run that made it.
        corrections:
          status === "ok" && total !== null
            ? { total, missing: 0, extra: 0, quantity: 0, amount: 0, charges: 0, printedTotal: 0 }
            : null,
        silent: num(f.get("silent")),
        firstMs: num(f.get("first-ms")),
        warmMs: numList(f.get("warm-ms")),
        stable: stable === "yes" ? true : stable === "no" ? false : null,
        tags: cleanTags((f.get("tags") ?? "").split(",").filter((t) => t && t !== "-")),
        coverage: coverageOf(f.get("coverage")),
        incomplete:
          f.get("incomplete") === "yes" ? true : f.get("incomplete") === "no" ? false : undefined,
      });
    }
  });
  return out;
}

/**
 * Summaries scored with different item-name rules must not be combined. Returns the refusal
 * reason, or null.
 */
export function nameMatchConflict(runs: readonly DesktopRun[]): string | null {
  const labels = new Set(runs.map((r) => r.info.nameMatch));
  return labels.size > 1
    ? `summaries used different name-match rules (${[...labels].sort().join(", ")}); re-run them with the same harness revision`
    : null;
}

// ---------------------------------------------------------------------------------------------
// Per-run aggregates

export interface EngineAggregate {
  engine: EngineId;
  receipts: number;
  within: number;
  silent: number;
  failed: number;
  unstable: number;
  sessionColdMs: number | null;
  firstMedianMs: number | null;
  warmMedianMs: number | null;
  /**
   * Median reading coverage (0..1) over the receipts with a measured coverage; a failed scan of a
   * receipt that has reference amounts counts as 0. null when nothing was measured.
   */
  coverageMedian: number | null;
  fields: Omit<Corrections, "total">;
}

/** Receipt IDs of a run (the denominator), in first-seen order. */
export const receiptIds = (run: DesktopRun) => [...new Set(run.results.map((r) => r.id))];

export function aggregate(run: DesktopRun, engine: EngineId): EngineAggregate {
  const ids = receiptIds(run);
  const rows = run.results.filter((r) => r.engine === engine);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fieldsSum = { missing: 0, extra: 0, quantity: 0, amount: 0, charges: 0, printedTotal: 0 };
  for (const r of rows)
    if (r.corrections)
      for (const k of Object.keys(fieldsSum) as Array<keyof typeof fieldsSum>)
        fieldsSum[k] += r.corrections[k];
  const warm = ids.map((id) => {
    const r = byId.get(id);
    return r ? warmMedian(r) : Infinity;
  });
  const first = ids.map((id) => {
    const r = byId.get(id);
    return r && r.status === "ok" && r.firstMs !== null ? r.firstMs : Infinity;
  });
  return {
    engine,
    receipts: ids.length,
    // A receipt with no row for this engine counts as a failure (stays in the denominator).
    within: ids.filter((id) => {
      const r = byId.get(id);
      return !!r && withinLimit(r);
    }).length,
    silent: rows.reduce((s, r) => s + (r.silent ?? 0), 0),
    failed: ids.filter((id) => byId.get(id)?.status !== "ok").length,
    unstable: rows.filter((r) => r.stable === false).length,
    sessionColdMs: rows[0]?.firstMs ?? null,
    firstMedianMs: median(first),
    warmMedianMs:
      run.info.warmRuns > 0 ? median(warm.filter((x): x is number => x !== null)) : null,
    coverageMedian: median(
      rows.flatMap((r) => {
        const s = coverageShare(r.coverage);
        return s === null ? [] : [r.status === "ok" ? s : 0];
      }),
    ),
    fields: fieldsSum,
  };
}

/** Within-2 share per photo-condition tag and engine (a receipt with several tags counts in each). */
export function conditionLines(run: DesktopRun): string[] {
  const tags = [...new Set(run.results.flatMap((r) => r.tags ?? []))].sort();
  const lines: string[] = [];
  for (const tag of tags)
    for (const engine of run.info.engines) {
      const ids = new Set(run.results.filter((r) => r.tags?.includes(tag)).map((r) => r.id));
      const rows = run.results.filter((r) => r.engine === engine && ids.has(r.id));
      const ok = [...ids].filter((id) => rows.some((r) => r.id === id && withinLimit(r))).length;
      lines.push(`condition | tag=${tag} | engine=${engine} | within-2=${share(ok, ids.size)}`);
    }
  return lines;
}

/** One engine's aggregate line: within-2 share, silent errors, failures and timings. */
export function engineLine(a: EngineAggregate): string {
  return `engine | engine=${a.engine} | within-2=${share(a.within, a.receipts)} | silent=${a.silent} | failed=${a.failed} | unstable=${a.unstable} | session-cold=${secs(a.sessionColdMs)} | first-median=${secs(a.firstMedianMs)} | warm-median=${secs(a.warmMedianMs)}${a.coverageMedian === null ? "" : ` | coverage-median=${(100 * a.coverageMedian).toFixed(1)}%`}`;
}

export function aggregateLines(run: DesktopRun, heldOut: boolean): string[] {
  const lines: string[] = [];
  for (const engine of run.info.engines) {
    const a = aggregate(run, engine);
    lines.push(engineLine(a));
    const f = a.fields;
    lines.push(
      `fields | engine=${engine} | missing=${f.missing} | extra=${f.extra} | quantity=${f.quantity} | amount=${f.amount} | charges=${f.charges} | printed-total=${f.printedTotal}`,
    );
  }
  lines.push(...conditionLines(run));
  if (!heldOut)
    for (const r of run.results) {
      const d = detailLine(r);
      if (d) lines.push(d);
    }
  return lines;
}

/**
 * A pasted run, re-written: its run and receipt lines plus its recomputed aggregates. Pasted lines
 * carry correction totals only, so no field breakdown or detail lines are shown for them.
 */
function runBlock(run: DesktopRun): string[] {
  const lines = [runLine(run.info, receiptIds(run).length), ...run.results.map(receiptLine)];
  for (const engine of run.info.engines) lines.push(engineLine(aggregate(run, engine)));
  return lines;
}

/** The block the owner copies from a run (this run, plus any pasted summaries). */
export function summaryBlock(
  run: DesktopRun,
  heldOut: boolean,
  pasted: Parsed = { runs: [], problems: [] },
): string {
  const lines = [
    SUMMARY_HEADER,
    runLine(run.info, receiptIds(run).length),
    ...run.results.map(receiptLine),
    ...aggregateLines(run, heldOut),
  ];
  const conflict = nameMatchConflict([run, ...pasted.runs]);
  if (conflict) {
    // This run is kept; the pasted summaries are refused, not combined.
    lines.push(`refused | pasted summaries not combined: ${conflict}`);
    return lines.join("\n");
  }
  for (const other of pasted.runs) lines.push(...runBlock(other));
  lines.push(...pasted.problems.map((p) => `note: pasted text ${p}`));
  return lines.join("\n");
}

/** A combined block from pasted text only (no run in this page). Lines are re-written, not copied. */
export function combinedBlock(parsed: Parsed): string {
  const lines = [SUMMARY_HEADER];
  const conflict = nameMatchConflict(parsed.runs);
  if (conflict) {
    lines.push(`refused | not combined: ${conflict}`);
    lines.push(...parsed.problems.map((p) => `note: pasted text ${p}`));
    return lines.join("\n");
  }
  for (const run of parsed.runs) lines.push(...runBlock(run));
  lines.push(...parsed.problems.map((p) => `note: pasted text ${p}`));
  return lines.join("\n");
}
