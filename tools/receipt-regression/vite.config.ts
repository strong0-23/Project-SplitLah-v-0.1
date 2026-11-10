import { defineConfig, type Plugin } from "vite";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PADDLE_MODEL_MANIFEST, PADDLE_MODEL_URL_DIR } from "../../src/lib/scan/paddle-assets";
import { TESSERACT_ASSET_MANIFEST } from "../../src/lib/scan/tesseract-assets";

const repo = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The engines' pinned files, served from the harness's own origin (127.0.0.1:8081), exactly as the
 * app serves them: Tesseract's from `public/tesseract/` and Paddle's model archives from
 * `paddle-models/`. Only the files named in the two manifests are served; nothing else in
 * `public/` and no receipt data. ONNX Runtime's WASM and the Paddle worker are served by Vite from
 * `node_modules` and `src/lib/scan` like any other module.
 */
function engineFiles(): Plugin {
  const routes = new Map<string, { file: string; type: string }>();
  for (const a of TESSERACT_ASSET_MANIFEST)
    routes.set(`/${a.path}`, {
      file: path.join(repo, "public", a.path),
      type: a.path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
    });
  for (const a of PADDLE_MODEL_MANIFEST)
    routes.set(`${PADDLE_MODEL_URL_DIR}${a.file}`, {
      file: path.join(repo, "paddle-models", a.file),
      type: "application/x-tar",
    });
  return {
    name: "harness-engine-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const route = routes.get(decodeURIComponent((req.url ?? "").split("?")[0] ?? ""));
        if (!route || (req.method !== "GET" && req.method !== "HEAD")) return next();
        res.setHeader("Content-Type", route.type);
        res.setHeader("Cache-Control", "no-cache");
        if (req.method === "HEAD") return void res.end();
        createReadStream(route.file).on("error", next).pipe(res);
      });
    },
  };
}

// Separate dev-only entry. Dataset files are read via the browser picker, never served by Vite.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  resolve: {
    // Same as the app (vite.config.ts): Paddle's runtime uses ONNX Runtime's WASM-only build.
    alias: [{ find: /^onnxruntime-web$/, replacement: "onnxruntime-web/wasm" }],
  },
  optimizeDeps: {
    // Pre-bundled up front, so a first Paddle or Tesseract scan never triggers a dependency
    // re-optimisation (which reloads the page and would end a run).
    include: ["tesseract.js", "zod", "@paddleocr/paddleocr-js"],
  },
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
    // Vite 8 copies browser console errors into this terminal by default when an AI agent runs
    // it. Off: nothing the page or the engines log may reach a terminal log (held-out safety).
    forwardConsole: false,
    fs: {
      allow: [
        fileURLToPath(new URL("../../src/lib", import.meta.url)),
        fileURLToPath(new URL(".", import.meta.url)),
        // The engines' code and WASM (tesseract.js, PaddleOCR SDK, ONNX Runtime).
        fileURLToPath(new URL("../../node_modules", import.meta.url)),
      ],
      deny: ["**/receipt-regression.local/**", "**/.git/**", "**/.env*"],
    },
  },
  plugins: [
    engineFiles(),
    {
      name: "local-harness-only",
      apply: "build",
      buildStart() {
        throw new Error("Receipt harness is dev-only. Use npm.cmd run receipts:dev.");
      },
    },
  ],
});
