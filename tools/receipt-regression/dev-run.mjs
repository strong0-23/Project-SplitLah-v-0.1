// Headless development runner (WO-001). DEVELOPMENT RECEIPTS ONLY; never point it at held-out data.
//
// Scans every photo in the private development folder with the app's own pipeline (the harness's
// "Engine scoring" source, development mode, no warm re-scans) in headless Chrome, and prints the
// summary block: receipt IDs and counts only (corrections, silent errors, first-scan time, reading
// coverage, per-field correction counts). It writes nothing to disk; the folder is read by the
// browser's file input only, as in the harness page.
//
//   SPLITLAH_DEV_RECEIPTS=/path/to/private/folder \
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs CHROME_PATH=/usr/bin/google-chrome \
//   node tools/receipt-regression/dev-run.mjs [--repeat N] [--ids REG001,REG002] [--revision label]
//
// --repeat N runs the whole set N times, each in a fresh browser (so each run's first receipt pays
// the engine load), and adds a timing block with each receipt's median first-scan time over the
// runs and the median of the runs' first-scan medians. Use it on a shared machine.
// HARNESS_PORT picks the dev server's port (default 8081).
//
// Dev-only like the rest of the harness: it starts the harness dev server (whose config refuses
// production builds), and it refuses to run with NODE_ENV=production. Playwright is not a project
// dependency.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (process.env.NODE_ENV === "production") {
  console.error("Refused: the development runner never runs with NODE_ENV=production.");
  process.exit(2);
}
const folder = process.env.SPLITLAH_DEV_RECEIPTS;
if (!folder) {
  console.error("Set SPLITLAH_DEV_RECEIPTS to the private development receipts folder.");
  process.exit(2);
}
const repeat = Math.max(1, Number(opt("--repeat") ?? 1) || 1);
const only = new Set(
  (opt("--ids") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);
const revision = opt("--revision") ?? "dev-run";
const PORT = Number(process.env.HARNESS_PORT ?? 8081);
const url = `http://127.0.0.1:${PORT}/`;

const idOf = (f) => /^([A-Za-z]{1,6}\d{1,6})[._]/.exec(f)?.[1]?.toUpperCase() ?? null;
const wanted = (f) => !only.size || only.has(idOf(f));
const names = readdirSync(folder).filter(wanted);
const photos = names.filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => path.join(folder, f));
const refs = names
  .filter((f) => /\.reference\.private\.json$/i.test(f))
  .map((f) => path.join(folder, f));
if (!photos.length || !refs.length) {
  console.error("No photos or references found in SPLITLAH_DEV_RECEIPTS (after --ids).");
  process.exit(2);
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--config",
    "tools/receipt-regression/vite.config.ts",
    "--port",
    String(PORT),
  ],
  { cwd: repo, stdio: ["ignore", "ignore", "ignore"] },
);

async function waitForServer(ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("harness dev server did not start");
}

/** One full pass in a fresh browser; returns the page's summary block (IDs and counts only). */
async function runOnce(label) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ["--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.selectOption("#source", "engine");
    await page.setChecked("#heldout", false);
    await page.selectOption("#warm", "0");
    await page.setInputFiles("#photos-files", photos);
    await page.setInputFiles("#references-files", refs);
    await page.fill("#revision", label);
    await page.waitForFunction(() => !document.querySelector("#run").disabled);
    await page.evaluate(() => (document.querySelector("#summary").value = ""));
    await page.click("#run");
    await page.waitForFunction(
      () => document.querySelector("#summary").value.includes("engine | engine="),
      null,
      { timeout: 60 * 60_000 },
    );
    return await page.inputValue("#summary");
  } finally {
    await browser.close();
  }
}

const field = (line, key) => new RegExp(`\\| ${key}=([^|]*)`).exec(line)?.[1]?.trim();
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

try {
  await waitForServer();
  const firstMs = new Map();
  const runMedians = [];
  for (let i = 0; i < repeat; i++) {
    const block = await runOnce(repeat > 1 ? `${revision}#${i + 1}` : revision);
    console.log(block);
    console.log("");
    const times = [];
    for (const line of block.split("\n")) {
      if (!line.startsWith("receipt | ")) continue;
      const id = field(line, "id");
      const ms = Number(field(line, "first-ms"));
      const t = field(line, "status") === "ok" && Number.isFinite(ms) ? ms : Infinity;
      times.push(t);
      firstMs.set(id, [...(firstMs.get(id) ?? []), t]);
    }
    runMedians.push(median(times));
  }
  if (repeat > 1) {
    console.log(`timing | runs=${repeat} | revision=${revision}`);
    for (const [id, ts] of firstMs)
      console.log(
        `timing | id=${id} | first-ms-median=${Math.round(median(ts))} | first-ms=${ts.map(Math.round).join(",")}`,
      );
    console.log(
      `timing | first-median-of-runs=${(median(runMedians) / 1000).toFixed(2)} s | run-first-medians=${runMedians.map((m) => (m / 1000).toFixed(2)).join(",")}`,
    );
  }
} finally {
  server.kill();
}
