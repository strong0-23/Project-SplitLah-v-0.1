/**
 * Self-hosted Tesseract files (Batch 2b): the pinned files exist in public/, match their manifest
 * byte for byte, match the installed package versions, and the adapter uses only same-origin URLs.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TESSERACT_ASSET_MANIFEST,
  TESSERACT_CORE_VERSION,
  TESSERACT_PATHS,
  TESSERACT_VERSION,
  tesseractAssetUrls,
} from "./tesseract-assets";

const root = path.resolve(__dirname, "../../..");
const pkgVersion = (name: string) =>
  (
    JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

describe("self-hosted Tesseract assets", () => {
  it.each(TESSERACT_ASSET_MANIFEST.map((a) => [a.path, a] as const))(
    "%s is present with its pinned size and SHA-256",
    (_, asset) => {
      const file = path.join(root, "public", asset.path);
      expect(statSync(file).size).toBe(asset.bytes);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(asset.sha256);
    },
  );

  it("pins the same versions as the installed tesseract.js and tesseract.js-core", () => {
    expect(pkgVersion("tesseract.js")).toBe(TESSERACT_VERSION);
    expect(pkgVersion("tesseract.js-core")).toBe(TESSERACT_CORE_VERSION);
  });

  it("serves the worker and both LSTM cores byte-identical to the installed packages", () => {
    const same = (pub: string, mod: string) =>
      expect(
        readFileSync(path.join(root, "public", pub)).equals(
          readFileSync(path.join(root, "node_modules", mod)),
        ),
      ).toBe(true);
    same(`tesseract/${TESSERACT_VERSION}/worker.min.js`, "tesseract.js/dist/worker.min.js");
    for (const core of ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"])
      same(`tesseract/${TESSERACT_CORE_VERSION}/core/${core}`, `tesseract.js-core/${core}`);
  });

  it("builds absolute same-origin URLs only", () => {
    const urls = tesseractAssetUrls("https://splitlah.example");
    expect(urls).toEqual({
      workerPath: `https://splitlah.example${TESSERACT_PATHS.worker}`,
      corePath: `https://splitlah.example${TESSERACT_PATHS.core}`,
      langPath: `https://splitlah.example${TESSERACT_PATHS.lang}`,
    });
    expect(JSON.stringify(urls)).not.toMatch(/jsdelivr|unpkg|cdn/i);
  });
});

describe("Tesseract adapter uses the self-hosted files", () => {
  afterEach(() => {
    vi.doUnmock("tesseract.js");
    vi.resetModules();
  });

  it("passes pinned same-origin worker/core/lang paths and no blob: worker to createWorker", async () => {
    const createWorker = vi.fn(async () => ({
      setParameters: vi.fn(async () => undefined),
      recognize: vi.fn(),
      terminate: vi.fn(async () => undefined),
    }));
    vi.doMock("tesseract.js", () => ({ createWorker, OEM: { LSTM_ONLY: 1 } }));
    const { createTesseractEngine } = await import("./tesseract-engine");
    const engine = createTesseractEngine();
    await engine.load(() => undefined);
    const opts = (createWorker.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    const origin = globalThis.location.origin;
    expect(opts).toMatchObject({ ...tesseractAssetUrls(origin), workerBlobURL: false });
    for (const key of ["workerPath", "corePath", "langPath"])
      expect(new URL(opts[key] as string).origin).toBe(origin);
    await engine.terminate();
  });
});
