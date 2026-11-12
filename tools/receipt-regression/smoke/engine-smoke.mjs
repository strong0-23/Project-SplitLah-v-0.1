// Headless smoke test of the engine scoring harness (Tesseract). SYNTHETIC DATA ONLY.
//
// 1. Renders two invented receipts as text onto a canvas (computer-rendered PNGs, never a photo)
//    and builds their verified references from the blank template (synthetic.mjs), in a new
//    temporary folder.
// 2. Starts the harness dev server (127.0.0.1:8081), opens it in headless Chrome, and runs the
//    engine scoring: once in held-out mode (3 warm re-scans) and once as a development run (no warm
//    re-scans) to check the detail view. Then the Batch 1b parser gate.
// 3. Checks the summary block, and that no product name or amount appears in the summary, the
//    page text in held-out mode, or the browser console; and that no request leaves the harness.
//
// Playwright is not a project dependency. Point PLAYWRIGHT_MODULE at an installed copy, and
// CHROME_PATH at a Chrome or Chromium binary if Playwright's own is not installed:
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
//   CHROME_PATH=/usr/bin/google-chrome node tools/receipt-regression/smoke/engine-smoke.mjs
import { spawn } from "node:child_process";
import { SECRETS, has, repo, writeSynthetic } from "./synthetic.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const fail = (msg) => {
  throw new Error(`SMOKE FAIL: ${msg}`);
};

async function waitForServer(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("harness dev server did not start");
}

const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--config", "tools/receipt-regression/vite.config.ts"],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
);
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  // Only the harness's own origin resolves: proves every engine file comes from it.
  args: ["--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});
const consoleLines = [];
try {
  const blank = await browser.newPage();
  const { files } = await writeSynthetic(blank);
  await blank.close();

  await waitForServer("http://127.0.0.1:8081/");
  const page = await browser.newPage();
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
  const external = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (
      !["127.0.0.1", ""].includes(u.hostname) &&
      !u.protocol.startsWith("blob") &&
      !u.protocol.startsWith("data")
    )
      external.push(u.hostname);
  });
  await page.goto("http://127.0.0.1:8081/");

  async function runOnce({ heldOut, warm }) {
    await page.selectOption("#source", "engine");
    await page.selectOption("#warm", String(warm));
    await page.setChecked("#heldout", heldOut);
    // The plain multi-file inputs: the fallback for browsers without folder picking.
    await page.setInputFiles(
      "#photos-files",
      files.map((f) => f.photo),
    );
    await page.setInputFiles(
      "#references-files",
      files.map((f) => f.reference),
    );
    await page.fill("#revision", "smoke");
    await page.waitForFunction(() => !document.querySelector("#run").disabled);
    const started = Date.now();
    await page.click("#run");
    const set = heldOut ? "set=held-out" : "set=development";
    await page.waitForFunction(
      (want) => document.querySelector("#summary").value.includes(want),
      set,
      { timeout: 15 * 60_000 },
    );
    return {
      summary: await page.inputValue("#summary"),
      pageText: await page.innerText("#results"),
      status: await page.innerText("#status"),
      seconds: Math.round((Date.now() - started) / 1000),
    };
  }

  const held = await runOnce({ heldOut: true, warm: 3 });
  console.log(`--- held-out run (${held.seconds} s) ---\n${held.summary}\n`);
  const receiptLines = held.summary.split("\n").filter((l) => l.startsWith("receipt |"));
  if (receiptLines.length !== 2) fail(`expected 2 receipt lines, got ${receiptLines.length}`);
  if (!receiptLines.every((l) => l.includes("engine=tesseract")))
    fail("every receipt line must be a Tesseract scan");
  if (!held.summary.includes("run | set=held-out | runtime=desktop | browser=Chrome"))
    fail("run line missing or wrong");
  for (const l of receiptLines) {
    if (!l.includes("status=ok")) fail(`a scan failed: ${l}`);
    if (!/warm-ms=\d+,\d+,\d+/.test(l)) fail(`three warm timings expected: ${l}`);
  }
  if (!held.summary.includes("engine | engine=tesseract | within-2=2/2 (100.0%) | silent=0"))
    fail("Tesseract should score both synthetic receipts within 2 corrections, no silent errors");
  if (/paddle|verdict|DECISION/i.test(held.summary))
    fail("summary still mentions Paddle or a verdict");
  if (!held.summary.includes("condition | tag=computer_rendered | engine=tesseract | within-2="))
    fail("photo-condition breakdown missing");
  if (/\| detail \|/.test(held.summary) || held.summary.includes("detail | id="))
    fail("held-out summary must not have per-receipt field detail");
  for (const s of SECRETS) {
    if (has(held.summary, s)) fail(`summary contains reference content "${s}"`);
    if (has(held.pageText, s)) fail(`held-out page shows reference content "${s}"`);
    if (has(held.status, s)) fail(`held-out status shows reference content "${s}"`);
  }
  const savedDisabled = await page.isDisabled("#save");
  if (!savedDisabled) fail("full report download must be off in held-out mode");

  const dev = await runOnce({ heldOut: false, warm: 0 });
  console.log(`--- development run (${dev.seconds} s) ---\n${dev.summary}\n`);
  if (!dev.summary.includes("run | set=development")) fail("development run line missing");
  if (!dev.summary.includes("detail | id=REG901 | engine=tesseract"))
    fail("development detail lines missing");
  if (!has(dev.pageText, "KAYA TOAST SET")) fail("development mode should show the detail view");
  for (const s of SECRETS) if (has(dev.summary, s)) fail(`dev summary contains "${s}"`);

  // The Batch 1b parser gate (parser-v2 vs rework, Tesseract OCR) still works, in held-out mode.
  await page.selectOption("#source", "owner");
  await page.setChecked("#heldout", true);
  await page.evaluate(() => (document.querySelector("#summary").value = ""));
  await page.click("#run");
  await page.waitForFunction(
    () => document.querySelector("#summary").value.includes("OVERALL:"),
    null,
    {
      timeout: 5 * 60_000,
    },
  );
  const gate = await page.inputValue("#summary");
  const gateText = await page.innerText("#results");
  console.log(`--- parser gate (held-out mode) ---\n${gate}\n`);
  if (!gate.includes("REG901 | gate: PASS") || !gate.includes("REG902 | gate: PASS"))
    fail("parser gate should pass on the synthetic receipts");
  for (const s of SECRETS)
    if (has(gate, s) || has(gateText, s)) fail(`parser gate shows "${s}" in held-out mode`);

  for (const s of SECRETS) {
    const hit = consoleLines.find((l) => has(l, s));
    if (hit) fail(`console output contains "${s}": ${hit.slice(0, 300)}`);
  }
  if (external.length)
    fail(`requests left the harness origin: ${[...new Set(external)].join(", ")}`);
  console.log(`console lines: ${consoleLines.length} (none contain reference content)`);
  for (const l of consoleLines) console.log(`  ${l.slice(0, 160)}`);
  console.log("SMOKE PASS");
} finally {
  await browser.close();
  server.kill();
}
