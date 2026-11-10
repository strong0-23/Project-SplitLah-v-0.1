/**
 * Phase 2c decision rule, summaries and pasting. Synthetic IDs and counts only.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  cleanTags,
  conditionLines,
  combinedBlock,
  describeUserAgent,
  median,
  parseSummaries,
  phoneLine,
  summaryBlock,
  verdict,
  type DesktopRun,
  type EngineId,
  type PhoneResult,
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

/** A result: `c` extra corrections, or "fail" for a failed scan. */
function res(id: string, engine: EngineId, c: number | "fail", silent = 0): ReceiptEngineResult {
  return c === "fail"
    ? {
        id,
        engine,
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
        engine,
        status: "ok",
        corrections: { ...zero, amount: c, total: c },
        silent,
        firstMs: 3000,
        warmMs: [2000, 2100, 2200],
        stable: true,
      };
}

/** A run of n receipts where the first `t` (Tesseract) / `p` (Paddle) need ≤ 2 corrections. */
function run(
  browser: string,
  n: number,
  t: number,
  p: number,
  over: Partial<RunInfo> = {},
  paddleSilent = 0,
): DesktopRun {
  const results: ReceiptEngineResult[] = [];
  for (const [engine, ok] of [
    ["tesseract", t],
    ["paddle", p],
  ] as const)
    for (let i = 0; i < n; i++)
      results.push(
        res(
          `REG${100 + i}`,
          engine,
          i < ok ? 1 : 3,
          engine === "paddle" && i === 0 ? paddleSilent : 0,
        ),
      );
  return {
    info: {
      set: "held-out",
      runtime: "desktop",
      browser,
      version: "1.0",
      os: "Windows",
      revision: "abc1234",
      engines: ["tesseract", "paddle"],
      warmRuns: 3,
      complete: true,
      ...over,
    },
    results,
  };
}

function phone(
  engine: EngineId,
  id: string,
  warm: Array<number | null>,
  corrections: number | null,
  label = "Pixel 8",
): PhoneResult {
  return {
    phone: label,
    engine,
    id,
    status: "ok",
    firstKind: "cold",
    firstMs: 20000,
    warmMs: warm,
    corrections,
    silent: corrections === null ? null : 0,
    userAgent: UA.android,
  };
}
const rule = (v: ReturnType<typeof verdict>, r: string) =>
  v.rules.find((x) => x.rule === r)!.status;

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

describe("desktop rules need BOTH Edge and Firefox", () => {
  it("is pending, never pass, while a required runtime is missing", () => {
    const v = verdict([run("Edge", 12, 6, 12)], []);
    expect(rule(v, "a")).toBe("pending");
    expect(rule(v, "b")).toBe("pending");
    expect(v.decision).toBe("pending");
    expect(v.notes).toContain("Firefox: missing");
  });

  it("can still fail on the runtime that is present", () => {
    const v = verdict([run("Edge", 12, 6, 6, {}, 1)], []);
    expect(rule(v, "a")).toBe("fail");
    expect(rule(v, "b")).toBe("fail");
    expect(v.decision).toBe("fail");
  });

  it("passes (a) and (b) only when both runtimes pass", () => {
    const v = verdict([run("Edge", 12, 6, 12), run("Firefox", 12, 6, 12)], []);
    expect(rule(v, "a")).toBe("pass");
    expect(rule(v, "b")).toBe("pass");
    // (c) and (d) have no phone data yet: the decision stays pending.
    expect(rule(v, "c")).toBe("pending");
    expect(v.decision).toBe("pending");
  });

  it("does not count development, incomplete, single-engine or other-browser runs", () => {
    for (const over of [
      { set: "development" as const },
      { complete: false },
      { engines: ["paddle"] as EngineId[] },
    ]) {
      const v = verdict([run("Edge", 12, 6, 12, over), run("Firefox", 12, 6, 12)], []);
      expect(rule(v, "b"), JSON.stringify(over)).toBe("pending");
    }
    const chrome = verdict([run("Chrome", 12, 0, 12), run("Firefox", 12, 6, 12)], []);
    expect(rule(chrome, "b")).toBe("pending");
    expect(chrome.notes.join(" ")).toContain("informational only");
  });

  it("refuses two runs of one browser, and different receipt sets", () => {
    expect(
      rule(
        verdict([run("Edge", 12, 6, 12), run("Edge", 12, 6, 12), run("Firefox", 12, 6, 12)], []),
        "b",
      ),
    ).toBe("pending");
    expect(rule(verdict([run("Edge", 12, 6, 12), run("Firefox", 11, 6, 11)], []), "b")).toBe(
      "pending",
    );
  });
});

describe("rule (b): at least 10 points more receipts within 2 corrections", () => {
  // n = 12: one receipt is about 8.3 points, so Paddle needs 2 more receipts than Tesseract.
  it("fails at +1 receipt (+8.3 points) and passes at +2 (+16.7 points) with n = 12", () => {
    expect(rule(verdict([run("Edge", 12, 7, 8), run("Firefox", 12, 7, 8)], []), "b")).toBe("fail");
    expect(rule(verdict([run("Edge", 12, 7, 9), run("Firefox", 12, 7, 9)], []), "b")).toBe("pass");
  });

  it("passes at exactly +10 points (n = 10, +1 receipt)", () => {
    expect(rule(verdict([run("Edge", 10, 5, 6), run("Firefox", 10, 5, 6)], []), "b")).toBe("pass");
  });

  it("keeps failed scans in the denominator", () => {
    const r = run("Edge", 12, 0, 0);
    r.results = r.results.map((x, i) =>
      x.engine === "paddle"
        ? i % 12 < 10
          ? res(x.id, "paddle", 0)
          : res(x.id, "paddle", "fail")
        : res(x.id, "tesseract", i < 8 ? 0 : 5),
    );
    const a = aggregate(r, "paddle");
    expect(a).toMatchObject({ receipts: 12, within: 10, failed: 2 });
    // Paddle 10/12 vs Tesseract 8/12: +16.7 points.
    expect(rule(verdict([r, { ...r, info: { ...r.info, browser: "Firefox" } }], []), "b")).toBe(
      "pass",
    );
  });

  it("counts a receipt with no Paddle row as a failure", () => {
    const r = run("Edge", 12, 6, 12);
    r.results = r.results.filter((x) => !(x.engine === "paddle" && x.id === "REG100"));
    expect(aggregate(r, "paddle")).toMatchObject({ receipts: 12, within: 11, failed: 1 });
  });
});

describe("70% stop rule", () => {
  it("needs 9 of 12 (75%) to reach 70%; 8 of 12 (66.7%) does not", () => {
    const stop = verdict([run("Edge", 12, 8, 8), run("Firefox", 12, 8, 8)], []);
    expect(stop.stop).toBe("fail");
    expect(stop.rules.find((r) => r.rule === "stop")!.text).toContain("STOP ENGINE WORK");
    expect(verdict([run("Edge", 12, 9, 8), run("Firefox", 12, 9, 8)], []).stop).toBe("pass");
  });

  it("an engine must reach 70% in each required runtime", () => {
    expect(verdict([run("Edge", 12, 9, 8), run("Firefox", 12, 8, 8)], []).stop).toBe("fail");
  });

  it("is pending while a runtime is missing, unless both engines already fall short", () => {
    expect(verdict([run("Edge", 12, 9, 9)], []).stop).toBe("pending");
    expect(verdict([run("Edge", 12, 5, 5)], []).stop).toBe("fail");
  });
});

describe("phone rules (c) and (d)", () => {
  const desktop = [run("Edge", 12, 6, 12), run("Firefox", 12, 6, 12)];

  it("(c) passes at a median warm scan of 8.0 s and fails above it", () => {
    expect(rule(verdict(desktop, [phone("paddle", "REG100", [7900, 8000, 8100], null)]), "c")).toBe(
      "pass",
    );
    expect(rule(verdict(desktop, [phone("paddle", "REG100", [8000, 8100, 8200], null)]), "c")).toBe(
      "fail",
    );
  });

  it("(c) counts failed warm scans as slowest, and needs Paddle timing on every phone", () => {
    expect(rule(verdict(desktop, [phone("paddle", "REG100", [7000, null, null], null)]), "c")).toBe(
      "fail",
    );
    expect(
      rule(
        verdict(desktop, [
          phone("paddle", "REG100", [7000, 7000, 7000], null),
          phone("tesseract", "REG100", [3000, 3000, 3000], null, "iPhone 15"),
        ]),
        "c",
      ),
    ).toBe("pending");
  });

  it("(d) compares receipts within 2 corrections per phone, over the same receipts", () => {
    const both = (p: number, t: number) => [
      phone("paddle", "REG100", [7000, 7000, 7000], p),
      phone("tesseract", "REG100", [3000, 3000, 3000], t),
    ];
    expect(rule(verdict(desktop, both(2, 2)), "d")).toBe("pass");
    expect(rule(verdict(desktop, both(3, 1)), "d")).toBe("fail");
    // No reference on the phone: correctness can't be judged.
    expect(
      rule(
        verdict(
          desktop,
          both(2, 2).map((x) => ({ ...x, corrections: null })),
        ),
        "d",
      ),
    ).toBe("pending");
    // Different receipts per engine.
    expect(
      rule(
        verdict(desktop, [
          phone("paddle", "REG100", [7000], 0),
          phone("tesseract", "REG101", [3000], 0),
        ]),
        "d",
      ),
    ).toBe("pending");
  });

  it("the decision passes only when every rule passes", () => {
    const phones = [
      phone("paddle", "REG100", [7000, 7000, 7000], 1),
      phone("tesseract", "REG100", [3000, 3000, 3000], 1),
    ];
    expect(verdict(desktop, phones).decision).toBe("pass");
    expect(verdict([desktop[0]!], phones).decision).toBe("pending");
  });
});

describe("summaries: IDs and counts only, and pasting", () => {
  it("round-trips run, receipt and phone lines", () => {
    const edge = run("Edge", 12, 6, 12);
    const firefox = run("Firefox", 12, 6, 12);
    const p = phone("paddle", "REG100", [7000, null, 7200], 1);
    const parsed = parseSummaries(
      [summaryBlock(edge, true), summaryBlock(firefox, true), phoneLine(p)].join("\n\n"),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.runs.map((r) => r.info.browser)).toEqual(["Edge", "Firefox"]);
    expect(parsed.runs[0]!.results).toHaveLength(24);
    expect(parsed.runs[0]!.results[0]).toMatchObject({
      id: "REG100",
      engine: "tesseract",
      status: "ok",
      silent: 0,
      warmMs: [2000, 2100, 2200],
    });
    expect(parsed.phones[0]).toMatchObject({
      phone: "Pixel 8",
      warmMs: [7000, null, 7200],
      corrections: 1,
    });
    expect(verdict(parsed.runs, parsed.phones)).toEqual(verdict([edge, firefox], [p]));
  });

  it("combining in one browser gives the same verdict as pasting everything", () => {
    const edge = run("Edge", 12, 6, 12);
    const firefox = run("Firefox", 12, 6, 12);
    const fromEdge = summaryBlock(edge, true, parseSummaries(summaryBlock(firefox, true)));
    expect(fromEdge).toContain("(a) zero silent financial errors (Paddle): PASS");
    expect(fromEdge).toContain(
      "(b) Paddle within-2 share >= Tesseract + 10 points (held-out): PASS",
    );
    expect(fromEdge).toContain(
      "n=12 held-out receipts: one receipt is about 8.3 percentage points",
    );
    expect(fromEdge).toContain("DECISION: PENDING");
  });

  it("shows per-receipt field detail only outside held-out mode", () => {
    const r = run("Edge", 2, 1, 1);
    expect(summaryBlock(r, true)).not.toContain("detail |");
    expect(summaryBlock(r, false)).toContain("detail | id=REG100 | engine=tesseract");
  });

  it("re-writes pasted text instead of copying it, so free text never passes through", () => {
    const pasted = [
      "run | set=held-out | runtime=desktop | browser=Firefox | version=145.0 | os=Windows | revision=x | engines=tesseract,paddle | warm-runs=3 | condition=first-use | complete=yes | receipts=1",
      "receipt | id=REG100 | engine=tesseract | status=ok | corrections=1 | silent=0 | first-ms=1 | warm-ms=1,1,1 | stable=yes | note=KAYA TOAST 9.00",
      "receipt | id=REG100 KAYA TOAST | engine=paddle | status=ok | corrections=0 | silent=0 | first-ms=1 | warm-ms=1 | stable=yes",
      "KAYA TOAST SET 2 9.00",
      "phone | phone=Pixel | engine=paddle | id=REG100 | status=ok | first=cold | first-ms=1 | warm-ms=1 | corrections=- | silent=- | ua=Mozilla/5.0 (Linux; Android 15)",
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
      "receipt | id=REG1 | engine=paddle | status=ok\nrun | set=secret",
    );
    expect(parsed.problems).toEqual([
      "line 1: unreadable receipt line (no run line above it)",
      "line 2: unreadable run line",
    ]);
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

  it("gives each tag's within-2 count per engine, and survives pasting", () => {
    const r = run("Edge", 4, 2, 4);
    r.results = r.results.map((x) => ({
      ...x,
      tags: x.id === "REG100" || x.id === "REG102" ? ["dim"] : ["flat"],
    }));
    expect(conditionLines(r)).toEqual([
      "condition | tag=dim | engine=tesseract | within-2=1/2 (50.0%)",
      "condition | tag=dim | engine=paddle | within-2=2/2 (100.0%)",
      "condition | tag=flat | engine=tesseract | within-2=1/2 (50.0%)",
      "condition | tag=flat | engine=paddle | within-2=2/2 (100.0%)",
    ]);
    const back = parseSummaries(summaryBlock(r, true)).runs[0]!;
    expect(conditionLines(back)).toEqual(conditionLines(r));
  });
});
