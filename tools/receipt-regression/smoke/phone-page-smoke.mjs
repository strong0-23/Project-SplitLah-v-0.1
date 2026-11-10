// Headless smoke test of the dev-only phone timing page (/dev/engine-timing). SYNTHETIC DATA ONLY.
//
// Needs an app build with the engine switch on, served locally, for example:
//   VITE_SPLITLAH_ENGINE_SWITCH=on npm run build
//   npx wrangler@4.154.0 dev --config cloudflare/wrangler.jsonc
// then (Playwright is not a project dependency; see engine-smoke.mjs):
//   PLAYWRIGHT_MODULE=... CHROME_PATH=... node tools/receipt-regression/smoke/phone-page-smoke.mjs [base-url]
//
// In an emulated phone it runs 1 + 3 scans of a synthetic receipt with each engine (one page load
// per engine) with its synthetic reference, prints the result lines, and checks that no product
// name or amount appears on the page or in the console.
import { SECRETS, has, writeSynthetic } from "./synthetic.mjs";

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.argv[2] ?? "http://127.0.0.1:8787";
const fail = (msg) => {
  throw new Error(`SMOKE FAIL: ${msg}`);
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    "--no-proxy-server",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
  ],
});
const consoleLines = [];
const lines = [];
try {
  const blank = await browser.newPage();
  const { files } = await writeSynthetic(blank);
  await blank.close();
  const [receipt] = files;

  for (const engine of ["paddle", "tesseract"]) {
    // A new context per engine: a fresh page session, as the owner does with one page load each.
    const context = await browser.newContext({ ...devices["Pixel 7"] });
    const page = await context.newPage();
    page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
    const response = await page.goto(`${base}/dev/engine-timing`);
    if (response?.status() !== 200) fail(`page answered ${response?.status()}`);
    await page.getByText("Engine timing (developer page)").waitFor({ timeout: 60_000 });
    await page.getByLabel("Engine").selectOption(engine);
    await page.getByLabel(/Phone label/).fill("Synthetic Pixel 7");
    await page.getByLabel(/Receipt photo/).setInputFiles(receipt.photo);
    await page.getByLabel(/Verified reference/).setInputFiles(receipt.reference);
    await page.getByText(/Reference for REG901 accepted/).waitFor();
    const started = Date.now();
    await page.getByRole("button", { name: /^Run 1 \+ 3 scans/ }).click();
    const box = page.locator("textarea");
    await box.waitFor({ timeout: 10 * 60_000 });
    const line = await box.inputValue();
    const text = await page.innerText("main");
    console.log(`${engine} (${Math.round((Date.now() - started) / 1000)} s):\n${line}\n`);
    if (
      !line.startsWith(`phone | phone=Synthetic Pixel 7 | engine=${engine} | id=REG901 | status=ok`)
    )
      fail(`unexpected result line for ${engine}`);
    if (!/warm-ms=\d+,\d+,\d+/.test(line)) fail("three warm timings expected");
    if (!/\| ua=Mozilla\/5\.0 \(Linux; Android/.test(line)) fail("device user agent missing");
    for (const s of SECRETS) if (has(text, s) || has(line, s)) fail(`page shows "${s}"`);
    lines.push(line);
    await context.close();
  }
  for (const s of SECRETS) {
    const hit = consoleLines.find((l) => has(l, s));
    if (hit) fail(`console output contains "${s}": ${hit.slice(0, 200)}`);
  }
  console.log(`console lines: ${consoleLines.length} (none contain reference content)`);
  console.log("SMOKE PASS");
} finally {
  await browser.close();
}
