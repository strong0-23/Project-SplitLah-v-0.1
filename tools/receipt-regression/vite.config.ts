import { defineConfig, type Plugin } from "vite";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TESSERACT_ASSET_MANIFEST } from "../../src/lib/scan/tesseract-assets";

const repo = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Tesseract's pinned files, served from the harness's own origin (127.0.0.1:8081), exactly as the
 * app serves them from `public/tesseract/`. Only the files named in the manifest are served;
 * nothing else in `public/` and no receipt data.
 */
function engineFiles(): Plugin {
  const routes = new Map<string, { file: string; type: string }>();
  for (const a of TESSERACT_ASSET_MANIFEST)
    routes.set(`/${a.path}`, {
      file: path.join(repo, "public", a.path),
      type: a.path.endsWith(".js") ? "text/javascript" : "application/octet-stream",
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
  optimizeDeps: {
    // Pre-bundled up front, so a first scan never triggers a dependency re-optimisation (which
    // reloads the page and would end a run).
    include: ["tesseract.js", "zod"],
  },
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
        // Tesseract's code (tesseract.js).
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
