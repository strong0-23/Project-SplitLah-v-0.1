// Headless smoke test of the app's scan → review → split journey (Batch 3). SYNTHETIC DATA ONLY.
//
// Renders an invented receipt as text onto a canvas (never a photo). Its header has a priced line
// ("Queue 58  3.00") that the printed total doesn't need, so the review screen should hide it under
// "1 line hidden — show". The test then:
//   1. uploads the image in the app served by `wrangler dev` (security headers on) and reads it;
//   2. checks the review screen: the hidden-lines expander, the "matches, with 1 line hidden" notice;
//   3. adds the hidden line back (the mismatch banner appears), deletes it again, undoes, deletes;
//   4. continues to the split step.
// Every request must stay on the app's own origin, except the app's existing web-font stylesheet
// (fonts.googleapis.com / fonts.gstatic.com, unchanged since the Lovable import; blocked here).
//
// Build first (`npx vite build`), then, with Playwright supplied by the caller:
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs CHROME_PATH=/usr/bin/google-chrome \
//   node tools/receipt-regression/smoke/review-smoke.mjs
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repo } from "./synthetic.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const PORT = Number(process.env.SMOKE_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;

const LINES = [
  "SAMPLE NOODLE HOUSE",
  "Queue 58            3.00",
  "Date 01/11/2026 12:30",
  "Wonton Noodles      6.40",
  "Barley Drink        1.70",
  "Total               8.10",
  "VISA                8.10",
];

const fail = (msg) => {
  throw new Error(`SMOKE FAIL: ${msg}`);
};

async function waitForServer(url, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("wrangler dev did not start");
}

const server = spawn(
  "npx",
  [
    "--yes",
    "wrangler@4.154.0",
    "dev",
    "--config",
    "cloudflare/wrangler.jsonc",
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
  ],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
const log = [];
server.stdout.on("data", (d) => log.push(String(d)));
server.stderr.on("data", (d) => log.push(String(d)));

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});
try {
  await waitForServer(`${BASE}/`);
  const page = await browser.newPage();
  const external = [];
  const errors = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    const fonts = ["fonts.googleapis.com", "fonts.gstatic.com"].includes(u.hostname);
    if (u.protocol.startsWith("http") && u.hostname !== "127.0.0.1" && !fonts)
      external.push(u.hostname);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);

  const dataUrl = await page.evaluate((lines) => {
    const c = document.createElement("canvas");
    c.width = 760;
    c.height = 80 + lines.length * 46;
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    g.font = "28px 'DejaVu Sans Mono', monospace";
    lines.forEach((l, i) => g.fillText(l, 30, 60 + i * 46));
    return c.toDataURL("image/png");
  }, LINES);
  const dir = await mkdtemp(path.join(tmpdir(), "splitlah-review-smoke-"));
  const png = path.join(dir, "synthetic-receipt.png");
  await writeFile(png, Buffer.from(dataUrl.split(",")[1], "base64"));

  await page.setInputFiles('input[aria-label="Upload a receipt image"]', png);
  await page.getByRole("button", { name: "Read receipt" }).click();
  await page.getByRole("heading", { name: "Review receipt" }).waitFor({ timeout: 180_000 });
  const t0 = await page.innerText("main");
  console.log("review: item fields:", await page.locator('input[id^="desc-"]').count());

  const toggle = page.getByRole("button", { name: "1 line hidden — show" });
  if (!(await toggle.count())) fail(`no hidden-lines expander:\n${t0}`);
  if (!t0.includes("Matches the receipt total, with 1 line hidden"))
    fail("hidden-lines notice missing");
  if (t0.includes("Matches the receipt total exactly."))
    fail("plain success shown with hidden lines");
  await toggle.click();
  await page.getByRole("button", { name: /^Add back/ }).click();
  await page.getByText(/Doesn't match the receipt total: over by SGD 3\.00/).waitFor();
  console.log("review: added back -> mismatch banner shown");

  const deletes = page.getByRole("button", { name: /^Delete item/ });
  const n = await deletes.count();
  await deletes.nth(n - 1).click();
  await page.getByRole("button", { name: "Undo" }).click();
  if ((await page.getByRole("button", { name: /^Delete item/ }).count()) !== n) fail("undo failed");
  await page.getByRole("button", { name: `Delete item ${n}` }).click();
  await page.getByText(/Matches the receipt total, with 1 line hidden/).waitFor();
  console.log("review: delete, undo, delete -> matches again");

  await page.getByRole("button", { name: "Continue to split" }).click();
  await page.waitForURL(/step=split/, { timeout: 30_000 });
  console.log("split: reached", new URL(page.url()).search);

  if (external.length) fail(`requests left the app: ${[...new Set(external)].join(", ")}`);
  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("SMOKE PASS");
} finally {
  await browser.close();
  try {
    process.kill(-server.pid);
  } catch {
    server.kill();
  }
}
