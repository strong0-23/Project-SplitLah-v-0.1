/**
 * Engine scoring summaries, aggregates and pasting (single-engine since Paddle's removal,
 * 11 Nov 2026). Synthetic IDs and counts only.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  cleanTags,
  conditionLines,
  combinedBlock,
  describeUserAgent,
  median,
  nameMatchConflict,
  parseSummaries,
  summaryBlock,
  type DesktopRun,
  type ReceiptEngineResult,
  type RunInfo,
} from "./comparison";

const zero = { missing: 0, extra: 0, quantity: 0, amount: 0, charges: 0, printedTotal: 0 };
const UA = {
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0",
  chrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
};

/** A Tesseract result: `c` extra corrections, or "fail" for a failed scan. */
function res(id: string, c: number | "fail", silent = 0): ReceiptEngineResult {
  return c === "fail"
    ? {
        id,
        engine: "tesseract",
        status: "failed",
        stage: "timeout",
        corrections: null,
        silent: null,
        firstMs: null,
        warmMs: [],
        stable: null,
      }
    : {
        id,
        engine: "tesseract",
        status: "ok",
        corrections: { ...zero, amount: c, total: c },
        silent,
        firstMs: 3000,
        warmMs: [2000, 2100, 2200],
        stable: true,
      };
}

/** A run of n receipts where the first `ok` need ≤ 2 corrections; the first has `silent` errors. */
function run(
  browser: string,
  n: number,
  ok: number,
  over: Partial<RunInfo> = {},
  silent = 0,
): DesktopRun {
  const results: ReceiptEngineResult[] = [];
  for (let i = 0; i < n; i++)
    results.push(res(`REG${100 + i}`, i < ok ? 1 : 3, i === 0 ? silent : 0));
  return {
    info: {
      set: "held-out",
      runtime: "desktop",
      browser,
      version: "1.0",
      os: "Windows",
      revision: "abc1234",
      engines: ["tesseract"],
      warmRuns: 3,
      nameMatch: "recognisable-0.70",
      complete: true,
      ...over,
    },
    results,
  };
}

describe("median", () => {
  it("handles odd, even, empty and failed (Infinity) values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([7000, Infinity, Infinity])).toBe(Infinity);
    expect(median([7000, 7500, Infinity])).toBe(7500);
  });
});

describe("describeUserAgent", () => {
  it("tells Edge, Firefox, Chrome and phones apart", () => {
    expect(describeUserAgent(UA.edge)).toEqual({
      browser: "Edge",
      version: "142.0.3595.53",
      os: "Windows",
      runtime: "desktop",
    });
    expect(describeUserAgent(UA.firefox)).toMatchObject({
      browser: "Firefox",
      version: "145.0",
      runtime: "desktop",
    });
    expect(describeUserAgent(UA.chrome)).toMatchObject({ browser: "Chrome", os: "Linux" });
    expect(describeUserAgent(UA.iphone)).toMatchObject({
      browser: "Safari",
      os: "iOS",
      runtime: "mobile",
    });
    expect(describeUserAgent(UA.android)).toMatchObject({
      browser: "Chrome",
      os: "Android",
      runtime: "mobile",
    });
  });
});

describe("aggregates", () => {
  it("counts receipts within 2 corrections, silent errors and timings", () => {
    const a = aggregate(run("Edge", 12, 5, {}, 2), "tesseract");
    expect(a).toMatchObject({
      receipts: 12,
      within: 5,
      silent: 2,
      failed: 0,
      unstable: 0,
      sessionColdMs: 3000,
      firstMedianMs: 3000,
      warmMedianMs: 2100,
    });
    expect(a.fields.amount).toBe(5 * 1 + 7 * 3);
  });

  it("keeps failed scans in the denominator", () => {
    const r = run("Edge", 12, 0);
    r.results = r.results.map((x, i) => (i < 10 ? res(x.id, 0) : res(x.id, "fail")));
    const a = aggregate(r, "tesseract");
    expect(a).toMatchObject({ receipts: 12, within: 10, failed: 2 });
    // A failed scan counts as the slowest first scan.
    expect(a.firstMedianMs).toBe(3000);
  });

  it("counts a cancelled scan as a failure, never within 2", () => {
    const r = run("Edge", 12, 12);
    r.results[0] = { ...res("REG100", 0), status: "cancelled", corrections: null };
    expect(aggregate(r, "tesseract")).toMatchObject({ receipts: 12, within: 11, failed: 1 });
  });

  it("writes one engine line per run, with the within-2 share as a count", () => {
    expect(summaryBlock(run("Edge", 7, 0, {}, 3), true)).toContain(
      "engine | engine=tesseract | within-2=0/7 (0.0%) | silent=3 | failed=0",
    );
  });
});

describe("summaries: IDs and counts only, and pasting", () => {
  it("round-trips run and receipt lines", () => {
    const edge = run("Edge", 12, 6);
    const firefox = run("Firefox", 12, 6);
    const parsed = parseSummaries(
      [summaryBlock(edge, true), summaryBlock(firefox, true)].join("\n\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.runs.map((r) => r.info.browser)).toEqual(["Edge", "Firefox"]);
    expect(parsed.runs[0]!.results).toHaveLength(12);
    expect(parsed.runs[0]!.results[0]).toMatchObject({
      id: "REG100",
      engine: "tesseract",
      status: "ok",
      silent: 0,
      warmMs: [2000, 2100, 2200],
    });
    expect(aggregate(parsed.runs[1]!, "tesseract")).toMatchObject({
      receipts: 12,
      within: 6,
      silent: 0,
    });
  });

  it("combining in one browser shows each pasted run with its recomputed aggregate", () => {
    const fromEdge = summaryBlock(
      run("Edge", 12, 6),
      true,
      parseSummaries(summaryBlock(run("Firefox", 12, 3, {}, 1), true)),
    );
    expect(fromEdge.match(/^run \|/gm)).toHaveLength(2);
    expect(fromEdge).toContain("engine | engine=tesseract | within-2=6/12 (50.0%) | silent=0");
    expect(fromEdge).toContain("engine | engine=tesseract | within-2=3/12 (25.0%) | silent=1");
    // The Paddle decision rule is gone.
    expect(fromEdge).not.toMatch(/verdict|DECISION|Paddle|stop rule/i);
  });

  it("shows per-receipt field detail only outside held-out mode", () => {
    const r = run("Edge", 2, 1);
    expect(summaryBlock(r, true)).not.toContain("detail |");
    expect(summaryBlock(r, false)).toContain("detail | id=REG100 | engine=tesseract");
  });

  it("re-writes pasted text instead of copying it, so free text never passes through", () => {
    const pasted = [
      "run | set=held-out | runtime=desktop | browser=Firefox | version=145.0 | os=Windows | revision=x | engines=tesseract | warm-runs=3 | condition=first-use | complete=yes | receipts=1",
      "receipt | id=REG100 | engine=tesseract | status=ok | corrections=1 | silent=0 | first-ms=1 | warm-ms=1,1,1 | stable=yes | note=KAYA TOAST 9.00",
      "receipt | id=REG100 KAYA TOAST | engine=tesseract | status=ok | corrections=0 | silent=0 | first-ms=1 | warm-ms=1 | stable=yes",
      "KAYA TOAST SET 2 9.00",
    ].join("\n");
    const out = combinedBlock(parseSummaries(pasted));
    expect(out).not.toMatch(/KAYA|TOAST|9\.00/);
    // An ID carrying text makes the whole line unreadable; plain text lines are ignored.
    expect(out).toContain("note: pasted text line 3: unreadable receipt line");
    expect(out).not.toContain("line 4");
    expect(out).toContain("receipt | id=REG100 | engine=tesseract | status=ok | corrections=1");
  });

  it("reports unreadable lines by line number only", () => {
    const parsed = parseSummaries(
      "receipt | id=REG1 | engine=tesseract | status=ok\nrun | set=secret",
    );
    expect(parsed.problems).toEqual([
      "line 1: unreadable receipt line (no run line above it)",
      "line 2: unreadable run line",
    ]);
  });

  it("treats Paddle lines from before the removal as unreadable, and ignores phone lines", () => {
    const old = [
      "run | set=held-out | runtime=desktop | browser=Edge | version=1 | os=Windows | revision=x | engines=tesseract,paddle | warm-runs=3 | condition=first-use | name-match=recognisable-0.70 | complete=yes | receipts=1",
      "receipt | id=REG100 | engine=paddle | status=ok | corrections=0 | silent=0 | first-ms=1 | warm-ms=1 | stable=yes",
      "phone | phone=Pixel | engine=paddle | id=REG100 | status=ok | first=cold | first-ms=1 | warm-ms=1 | corrections=- | silent=- | ua=x",
    ].join("\n");
    const parsed = parseSummaries(old);
    expect(parsed.runs).toEqual([]);
    expect(parsed.problems).toEqual([
      "line 1: unreadable run line",
      "line 2: unreadable receipt line (no run line above it)",
    ]);
  });
});

describe("name-match rule in summaries (owner decision, 11 Nov 2026)", () => {
  const exactRun = (browser: string) => run(browser, 12, 6, { nameMatch: "exact" });

  it("writes name-match=recognisable-0.70 on the run line and reads it back", () => {
    const block = summaryBlock(run("Edge", 2, 1), true);
    expect(block).toMatch(/^run \| .*\| name-match=recognisable-0\.70 \|/m);
    expect(parseSummaries(block).runs[0]!.info.nameMatch).toBe("recognisable-0.70");
  });

  it("reads a run line written before the field existed as exact", () => {
    const legacy =
      "run | set=held-out | runtime=desktop | browser=Firefox | version=145.0 | os=Windows | revision=x | engines=tesseract | warm-runs=3 | condition=first-use | complete=yes | receipts=1";
    expect(parseSummaries(legacy).runs[0]!.info.nameMatch).toBe("exact");
  });

  it("combines summaries that used the same rule", () => {
    const parsed = parseSummaries(
      [summaryBlock(run("Edge", 12, 6), true), summaryBlock(run("Firefox", 12, 6), true)].join(
        "\n",
      ),
    );
    expect(nameMatchConflict(parsed.runs)).toBeNull();
    expect(combinedBlock(parsed).match(/^engine \|/gm)).toHaveLength(2);
  });

  it("refuses to combine summaries with different rules", () => {
    const parsed = parseSummaries(
      [summaryBlock(run("Edge", 12, 6), true), summaryBlock(exactRun("Firefox"), true)].join("\n"),
    );
    const out = combinedBlock(parsed);
    expect(out).toContain(
      "refused | not combined: summaries used different name-match rules (exact, recognisable-0.70)",
    );
    expect(out).not.toMatch(/^(run|receipt|engine) \|/m);
  });

  it("keeps this browser's own run but refuses a pasted summary with another rule", () => {
    const out = summaryBlock(
      run("Edge", 12, 6),
      true,
      parseSummaries(summaryBlock(exactRun("Firefox"), true)),
    );
    expect(out).toContain("refused | pasted summaries not combined");
    expect(out.match(/^run \|/gm)).toHaveLength(1);
    expect(out).toContain("browser=Edge");
    expect(out).not.toContain("browser=Firefox");
  });
});

describe("photo-condition breakdown", () => {
  it("keeps plain tag words only", () => {
    expect(
      cleanTags(["Dim light", "curled", "curled", "KAYA TOAST 9.00", 7, "a".repeat(30)]),
    ).toEqual(["dim_light", "curled"]);
    expect(cleanTags("faded; long")).toEqual(["faded", "long"]);
    expect(cleanTags(null)).toEqual([]);
  });

  it("gives each tag's within-2 count, and survives pasting", () => {
    const r = run("Edge", 4, 2);
    r.results = r.results.map((x) => ({
      ...x,
      tags: x.id === "REG100" || x.id === "REG102" ? ["dim"] : ["flat"],
    }));
    expect(conditionLines(r)).toEqual([
      "condition | tag=dim | engine=tesseract | within-2=1/2 (50.0%)",
      "condition | tag=flat | engine=tesseract | within-2=1/2 (50.0%)",
    ]);
    const back = parseSummaries(summaryBlock(r, true)).runs[0]!;
    expect(conditionLines(back)).toEqual(conditionLines(r));
  });
});
