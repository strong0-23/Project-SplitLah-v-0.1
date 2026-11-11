/**
 * Phase 2c engine comparison: per-receipt results, the shareable summary (receipt IDs and counts
 * only), pasting summaries from other browsers and phones, and the owner's decision rule. Pure.
 *
 * Decision rule (owner-approved, unchanged). PaddleOCR replaces Tesseract only if ALL hold:
 *   (a) zero silent financial errors for Paddle;
 *   (b) on the held-out set, Paddle's share of receipts needing ≤ 2 extra corrections is at least
 *       10 percentage points higher than Tesseract's;
 *   (c) Paddle's median WARM scan time on each tested phone is ≤ 8 s;
 *   (d) Paddle's correctness on each tested phone is at least Tesseract's.
 * Stop rule: if neither engine reaches 70% of receipts at ≤ 2 corrections, engine work stops.
 *
 * How this module applies it:
 * - (a), (b) and the stop rule come from complete held-out desktop runs in "Both" mode. The desktop
 *   verdict needs BOTH Edge and Firefox; a missing runtime is "pending", never a pass. Each rule
 *   must hold in each of them. An engine "reaches 70%" only if it does so in each of them.
 * - Failed and timed-out scans stay in the denominators (they are not within 2 corrections, and a
 *   failed timing counts as infinitely slow in a median).
 * - (c) and (d) come from phone results (the dev timing page). (d) compares, per phone, the number
 *   of receipts within 2 corrections, over the same receipts scanned with both engines.
 * - Anything without data is "pending". Only data, never missing data, can produce "pass".
 */
import { MAX_CORRECTIONS, type Corrections } from "./corrections";

export type EngineId = "tesseract" | "paddle";
export const ENGINES: readonly EngineId[] = ["tesseract", "paddle"];
export const ENGINE_LABEL: Record<EngineId, string> = { tesseract: "Tesseract", paddle: "Paddle" };
export type Tri = "pass" | "fail" | "pending";

/** Phone rule (c). */
export const MAX_WARM_MS = 8000;
/** Desktop browsers the verdict needs (owner rule). */
export const REQUIRED_DESKTOP = ["Edge", "Firefox"] as const;

/** One receipt scanned by one engine. IDs, counts and timings only: never receipt content. */
export interface ReceiptEngineResult {
  id: string;
  engine: EngineId;
  status: "ok" | "failed" | "cancelled";
  /** Stage of a failure (decode, load, orient, recognize, timeout, input, parse). */
  stage?: string | undefined;
  /** null when not scored (failed scan, or no reference on the phone page). */
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
  complete: boolean;
}

export interface DesktopRun {
  info: RunInfo;
  results: ReceiptEngineResult[];
}

export interface PhoneResult {
  /** Owner's label, or the user agent when none was given. */
  phone: string;
  engine: EngineId;
  id: string;
  status: "ok" | "failed";
  stage?: string | undefined;
  /** First scan in the page session (cold) or a later photo in the same session. */
  firstKind: "cold" | "repeat";
  firstMs: number | null;
  warmMs: Array<number | null>;
  /** Extra corrections; null when no verified reference was chosen. */
  corrections: number | null;
  silent: number | null;
  userAgent: string;
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
/** Failure stages are short lowercase words (decode, load, orient, recognize, timeout …). */
export const cleanStage = (s: string) => (/^[a-z]{1,12}$/.test(s) ? s : "other");

// ---------------------------------------------------------------------------------------------
// Summary lines (machine-readable; only `run`, `receipt` and `phone` lines are read back)

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
  ].join(" | ");
}

/** Per-receipt field breakdown: development runs only (held-out runs show aggregates only). */
export function detailLine(r: ReceiptEngineResult): string | null {
  if (!r.corrections) return null;
  const c = r.corrections;
  return `detail | id=${cleanId(r.id)} | engine=${r.engine} | missing=${c.missing} | extra=${c.extra} | quantity=${c.quantity} | amount=${c.amount} | charges=${c.charges} | printed-total=${c.printedTotal}`;
}

export function phoneLine(p: PhoneResult): string {
  return [
    "phone",
    `phone=${clean(p.phone, 120) || "unlabelled"}`,
    `engine=${p.engine}`,
    `id=${cleanId(p.id) || "photo"}`,
    `status=${p.status}`,
    ...(p.stage ? [`stage=${cleanStage(p.stage)}`] : []),
    `first=${p.firstKind}`,
    `first-ms=${ms(p.firstMs)}`,
    `warm-ms=${msList(p.warmMs)}`,
    `median-warm-ms=${ms(median(withFailures(p.warmMs)))}`,
    `corrections=${p.corrections ?? "-"}`,
    `silent=${p.silent ?? "-"}`,
    // Last, so it may contain anything but the separators removed by `clean`.
    `ua=${clean(p.userAgent, 300)}`,
  ].join(" | ");
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
const engineOf = (v: string | undefined): EngineId | null =>
  v === "tesseract" || v === "paddle" ? v : null;

export interface Parsed {
  runs: DesktopRun[];
  phones: PhoneResult[];
  /** Problems found while reading (line numbers and reasons, no content). */
  problems: string[];
}

/**
 * Reads summary blocks (from this or another browser) and phone result lines. Only the structured
 * `run`, `receipt` and `phone` lines are read; all other lines (headers, verdicts) are ignored and
 * recomputed. Each `run` line starts a new desktop run; `receipt` lines belong to the run above.
 */
export function parseSummaries(text: string): Parsed {
  const out: Parsed = { runs: [], phones: [], problems: [] };
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
      if (
        (set !== "held-out" && set !== "development") ||
        (runtime !== "desktop" && runtime !== "mobile") ||
        engines.some((e) => e === null)
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
        // Pasted lines carry the total only; the breakdown is not needed for the verdict.
        corrections:
          status === "ok" && total !== null
            ? { total, missing: 0, extra: 0, quantity: 0, amount: 0, charges: 0, printedTotal: 0 }
            : null,
        silent: num(f.get("silent")),
        firstMs: num(f.get("first-ms")),
        warmMs: numList(f.get("warm-ms")),
        stable: stable === "yes" ? true : stable === "no" ? false : null,
        tags: cleanTags((f.get("tags") ?? "").split(",").filter((t) => t && t !== "-")),
      });
    } else if (kind === "phone") {
      const engine = engineOf(f.get("engine"));
      const status = f.get("status");
      const uaAt = line.indexOf(" | ua=");
      const pid = f.get("id") === "photo" ? "photo" : cleanId(f.get("id") ?? "");
      if (!engine || !pid || (status !== "ok" && status !== "failed")) {
        out.problems.push(`${where}: unreadable phone line`);
        return;
      }
      const userAgent = uaAt >= 0 ? clean(line.slice(uaAt + 6), 300) : "";
      out.phones.push({
        phone: clean(f.get("phone") ?? "", 120) || userAgent || "unlabelled",
        engine,
        id: pid,
        status,
        stage: f.get("stage") ? cleanStage(f.get("stage")!) : undefined,
        firstKind: f.get("first") === "repeat" ? "repeat" : "cold",
        firstMs: num(f.get("first-ms")),
        warmMs: numList(f.get("warm-ms")),
        corrections: num(f.get("corrections")),
        silent: num(f.get("silent")),
        userAgent,
      });
    }
  });
  return out;
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

export function aggregateLines(run: DesktopRun, heldOut: boolean): string[] {
  const lines: string[] = [];
  for (const engine of run.info.engines) {
    const a = aggregate(run, engine);
    lines.push(
      `engine | engine=${engine} | within-2=${share(a.within, a.receipts)} | silent=${a.silent} | failed=${a.failed} | unstable=${a.unstable} | session-cold=${secs(a.sessionColdMs)} | first-median=${secs(a.firstMedianMs)} | warm-median=${secs(a.warmMedianMs)}`,
    );
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

// ---------------------------------------------------------------------------------------------
// Verdict

export interface RuleVerdict {
  rule: "a" | "b" | "c" | "d" | "stop";
  /** For the stop rule: pass = continue, fail = STOP. */
  status: Tri;
  text: string;
}

const all = (xs: Tri[]): Tri =>
  xs.includes("fail") ? "fail" : xs.length === 0 || xs.includes("pending") ? "pending" : "pass";

/** Which desktop runs count, per required browser, with reasons for anything not counted. */
export function desktopRuntimes(runs: readonly DesktopRun[]) {
  const notes: string[] = [];
  const chosen = new Map<string, DesktopRun | null>();
  for (const browser of REQUIRED_DESKTOP) {
    const candidates = runs.filter(
      (r) => r.info.browser === browser && r.info.runtime === "desktop",
    );
    const eligible = candidates.filter(
      (r) =>
        r.info.set === "held-out" &&
        r.info.complete &&
        ENGINES.every((e) => r.info.engines.includes(e)),
    );
    if (eligible.length === 1) chosen.set(browser, eligible[0]!);
    else {
      chosen.set(browser, null);
      if (eligible.length > 1)
        notes.push(`${browser}: ${eligible.length} held-out runs pasted; keep one per browser`);
      else if (candidates.length)
        notes.push(
          `${browser}: no complete held-out run in Both mode (${candidates.map((r) => `${r.info.set}${r.info.complete ? "" : ", incomplete"}, ${r.info.engines.join("+")}`).join("; ")})`,
        );
      else notes.push(`${browser}: missing`);
    }
  }
  const present = [...chosen.values()].filter((r): r is DesktopRun => !!r);
  if (present.length === 2) {
    const [x, y] = present.map((r) => receiptIds(r).sort().join(","));
    if (x !== y) {
      notes.push("Edge and Firefox ran different receipt sets: desktop rules stay pending");
      for (const k of chosen.keys()) chosen.set(k, null);
    }
  }
  const ignored = runs.filter((r) => ![...chosen.values()].includes(r));
  for (const r of ignored)
    if (!REQUIRED_DESKTOP.includes(r.info.browser as (typeof REQUIRED_DESKTOP)[number]))
      notes.push(
        `${r.info.browser} ${r.info.version} (${r.info.runtime}, ${r.info.set}): informational only`,
      );
  return { chosen, notes };
}

export function verdict(
  runs: readonly DesktopRun[],
  phones: readonly PhoneResult[],
): {
  rules: RuleVerdict[];
  decision: Tri;
  stop: Tri;
  notes: string[];
} {
  const { chosen, notes } = desktopRuntimes(runs);
  const per = <T>(f: (run: DesktopRun) => T) =>
    REQUIRED_DESKTOP.map((b) => {
      const run = chosen.get(b) ?? null;
      return { browser: b, run, value: run ? f(run) : null };
    });

  // (a) zero silent financial errors (Paddle), in each required desktop runtime.
  const a = per((run) => aggregate(run, "paddle"));
  const aStatus = all(
    a.map((x) => (x.value ? (x.value.silent === 0 ? "pass" : "fail") : "pending")),
  );
  const aText = a
    .map((x) => `${x.browser} ${x.value ? `${x.value.silent} silent` : "pending"}`)
    .join("; ");

  // (b) Paddle's share at ≤ 2 corrections at least 10 points above Tesseract's.
  // Exact integer test: 100·p/nP − 100·t/nT ≥ 10  ⇔  10·(p·nT − t·nP) ≥ nP·nT.
  const b = per((run) => ({ t: aggregate(run, "tesseract"), p: aggregate(run, "paddle") }));
  const bStatus = all(
    b.map(({ value: v }) =>
      !v || !v.p.receipts
        ? "pending"
        : 10 * (v.p.within * v.t.receipts - v.t.within * v.p.receipts) >=
            v.p.receipts * v.t.receipts
          ? "pass"
          : "fail",
    ),
  );
  const bText = b
    .map(({ browser, value: v }) => {
      if (!v) return `${browser} pending`;
      const diff = v.p.receipts
        ? (100 * v.p.within) / v.p.receipts - (100 * v.t.within) / v.t.receipts
        : 0;
      return `${browser} Paddle ${share(v.p.within, v.p.receipts)} vs Tesseract ${share(v.t.within, v.t.receipts)}, ${diff >= 0 ? "+" : ""}${diff.toFixed(1)} points`;
    })
    .join("; ");

  // Stop rule: does each engine reach 70% (10·k ≥ 7·n) in every required runtime?
  const reaches = (engine: EngineId) =>
    all(
      b.map(({ value: v }) => {
        if (!v) return "pending";
        const x = engine === "paddle" ? v.p : v.t;
        return x.receipts && 10 * x.within >= 7 * x.receipts ? "pass" : "fail";
      }),
    );
  const rt = reaches("tesseract");
  const rp = reaches("paddle");
  const stop: Tri =
    rt === "pass" || rp === "pass" ? "pass" : rt === "fail" && rp === "fail" ? "fail" : "pending";

  // Phones.
  const byPhone = new Map<string, PhoneResult[]>();
  for (const p of phones) byPhone.set(p.phone, [...(byPhone.get(p.phone) ?? []), p]);
  // Repeated runs of the same receipt and engine on one phone: the last one pasted counts.
  const latest = (list: PhoneResult[]) => {
    const m = new Map<string, PhoneResult>();
    for (const p of list) m.set(`${p.engine}:${p.id}`, p);
    return [...m.values()];
  };
  const cParts: Tri[] = [];
  const cTexts: string[] = [];
  const dParts: Tri[] = [];
  const dTexts: string[] = [];
  for (const [phone, list] of byPhone) {
    const rows = latest(list);
    const name = phone.length > 60 ? `${phone.slice(0, 57)}...` : phone;
    const paddle = rows.filter((r) => r.engine === "paddle");
    const tess = rows.filter((r) => r.engine === "tesseract");
    // (c) pooled warm times of Paddle on this phone; a failed scan counts as infinitely slow.
    const warm = paddle.flatMap((r) =>
      r.status === "ok" ? withFailures(r.warmMs) : [Infinity, Infinity, Infinity],
    );
    const m = median(warm);
    if (m === null) {
      cParts.push("pending");
      cTexts.push(`${name}: no Paddle timing`);
    } else {
      cParts.push(m <= MAX_WARM_MS ? "pass" : "fail");
      const tm = median(
        tess.flatMap((r) => (r.status === "ok" ? withFailures(r.warmMs) : [Infinity])),
      );
      cTexts.push(
        `${name}: Paddle median warm ${secs(m)} over ${warm.length} warm scan(s)${tm === null ? "" : ` (Tesseract ${secs(tm)})`}`,
      );
    }
    // (d) same receipts with both engines, each scored against a verified reference.
    const ids = (xs: PhoneResult[]) =>
      xs
        .map((x) => x.id)
        .sort()
        .join(",");
    const scored = (xs: PhoneResult[]) =>
      xs.every((x) => x.status === "failed" || x.corrections !== null);
    const ok = (xs: PhoneResult[]) =>
      xs.filter(
        (x) => x.status === "ok" && x.corrections !== null && x.corrections <= MAX_CORRECTIONS,
      ).length;
    if (!paddle.length || !tess.length) {
      dParts.push("pending");
      dTexts.push(`${name}: needs both engines`);
    } else if (ids(paddle) !== ids(tess)) {
      dParts.push("pending");
      dTexts.push(`${name}: different receipts per engine`);
    } else if (!scored(paddle) || !scored(tess)) {
      dParts.push("pending");
      dTexts.push(`${name}: some scans have no verified reference`);
    } else {
      const p = ok(paddle);
      const t = ok(tess);
      dParts.push(p >= t ? "pass" : "fail");
      dTexts.push(
        `${name}: within 2 corrections Paddle ${share(p, paddle.length)} vs Tesseract ${share(t, tess.length)}`,
      );
    }
  }
  const cStatus = all(cParts);
  const dStatus = all(dParts);
  const noPhones = byPhone.size === 0 ? "no phone results" : "";

  const n = Math.max(0, ...[...chosen.values()].map((r) => (r ? receiptIds(r).length : 0)));
  if (n)
    notes.push(
      `n=${n} held-out receipts: one receipt is about ${(100 / n).toFixed(1)} percentage points`,
    );

  const rules: RuleVerdict[] = [
    {
      rule: "a",
      status: aStatus,
      text: `(a) zero silent financial errors (Paddle): ${aStatus.toUpperCase()} (${aText})`,
    },
    {
      rule: "b",
      status: bStatus,
      text: `(b) Paddle within-2 share >= Tesseract + 10 points (held-out): ${bStatus.toUpperCase()} (${bText})`,
    },
    {
      rule: "c",
      status: cStatus,
      text: `(c) Paddle median warm scan <= 8 s on each phone: ${cStatus.toUpperCase()} (${noPhones || cTexts.join("; ")})`,
    },
    {
      rule: "d",
      status: dStatus,
      text: `(d) Paddle correctness >= Tesseract on each phone: ${dStatus.toUpperCase()} (${noPhones || dTexts.join("; ")})`,
    },
    {
      rule: "stop",
      status: stop,
      text: `70% stop rule: ${stop === "pass" ? "CONTINUE (an engine reaches 70%)" : stop === "fail" ? "STOP ENGINE WORK (neither engine reaches 70%)" : "PENDING"} (Tesseract ${rt}, Paddle ${rp}; reaching means >= 70% within 2 corrections in each required desktop runtime)`,
    },
  ];
  return { rules, decision: all([aStatus, bStatus, cStatus, dStatus]), stop, notes };
}

export function verdictLines(
  runs: readonly DesktopRun[],
  phones: readonly PhoneResult[],
): string[] {
  const v = verdict(runs, phones);
  return [
    "-- verdict (desktop needs Edge AND Firefox held-out runs; missing data is PENDING, never PASS) --",
    ...v.notes.map((n) => `note: ${n}`),
    ...v.rules.map((r) => r.text),
    `DECISION: ${
      v.decision === "pass"
        ? "PASS: Paddle meets rules (a)-(d)"
        : v.decision === "fail"
          ? "FAIL: Paddle does not replace Tesseract"
          : "PENDING"
    }. The owner decides; the default engine is not changed by this tool.`,
  ];
}

/** The block the owner copies from a desktop run (this run, plus any pasted summaries). */
export function summaryBlock(
  run: DesktopRun,
  heldOut: boolean,
  pasted: Parsed = { runs: [], phones: [], problems: [] },
): string {
  const lines = [
    SUMMARY_HEADER,
    runLine(run.info, receiptIds(run).length),
    ...run.results.map(receiptLine),
    ...aggregateLines(run, heldOut),
  ];
  for (const other of pasted.runs) {
    lines.push(runLine(other.info, receiptIds(other).length), ...other.results.map(receiptLine));
  }
  lines.push(...pasted.phones.map(phoneLine));
  lines.push(...pasted.problems.map((p) => `note: pasted text ${p}`));
  lines.push(...verdictLines([run, ...pasted.runs], pasted.phones));
  return lines.join("\n");
}

/** A combined block from pasted text only (no run in this page). Lines are re-written, not copied. */
export function combinedBlock(parsed: Parsed): string {
  const lines = [SUMMARY_HEADER];
  for (const run of parsed.runs)
    lines.push(runLine(run.info, receiptIds(run).length), ...run.results.map(receiptLine));
  lines.push(...parsed.phones.map(phoneLine));
  lines.push(...parsed.problems.map((p) => `note: pasted text ${p}`));
  lines.push(...verdictLines(parsed.runs, parsed.phones));
  return lines.join("\n");
}
