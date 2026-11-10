// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv, type Plugin } from "vite";
import {
  engineSwitchForBuild,
  PADDLE_MODEL_MANIFEST,
  PADDLE_MODEL_SOURCE_DIR,
  PADDLE_MODEL_URL_DIR,
} from "./src/lib/scan/paddle-assets";

const modelsDir = fileURLToPath(new URL(`./${PADDLE_MODEL_SOURCE_DIR}/`, import.meta.url));

/**
 * Dev engine switch at build time, and the PaddleOCR model archives (21.5 MB, dev-only engine).
 *
 * The archives live in `paddle-models/`, outside `public/`, so a normal production build doesn't
 * ship them. They are served at `/paddle/` only when the switch is compiled in, using the same
 * condition as `engine-select.ts` (`import.meta.env.DEV || VITE_SPLITLAH_ENGINE_SWITCH === "on"`):
 *   - `npm run dev`: served straight from `paddle-models/`;
 *   - a build with the switch on: copied into the client output as `paddle/*.tar`.
 * On the Cloudflare production branch (WORKERS_CI_BRANCH=main) a requested switch is refused and
 * VITE_SPLITLAH_ENGINE_SWITCH is compiled as "", so production never ships Paddle (docs/DEPLOY.md).
 */
function paddleModels(): Plugin {
  let switchOn = false;
  let blocked = false;
  const files = new Set(PADDLE_MODEL_MANIFEST.map((a) => a.file));
  return {
    name: "splitlah:paddle-models",
    config(_, { mode }) {
      const requested = loadEnv(mode, process.cwd(), "VITE_")["VITE_SPLITLAH_ENGINE_SWITCH"];
      blocked = engineSwitchForBuild(requested, process.env["WORKERS_CI_BRANCH"]) === "blocked";
      if (!blocked) return;
      console.warn(
        "[splitlah] VITE_SPLITLAH_ENGINE_SWITCH=on ignored on the production branch: building without Paddle.",
      );
      return { define: { "import.meta.env.VITE_SPLITLAH_ENGINE_SWITCH": JSON.stringify("") } };
    },
    configResolved(config) {
      switchOn =
        config.env["DEV"] === true ||
        (!blocked && config.env["VITE_SPLITLAH_ENGINE_SWITCH"] === "on");
    },
    configureServer(server) {
      server.middlewares.use(PADDLE_MODEL_URL_DIR, (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0] ?? "").replace(/^\//, "");
        if (!switchOn || !files.has(name)) return next();
        res.setHeader("Content-Type", "application/x-tar");
        createReadStream(path.join(modelsDir, name)).pipe(res);
      });
    },
    generateBundle() {
      if (!switchOn || this.environment.name !== "client") return;
      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `${PADDLE_MODEL_URL_DIR.replace(/^\//, "")}${file}`,
          source: readFileSync(path.join(modelsDir, file)),
        });
      }
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  plugins: [paddleModels()],
  vite: {
    resolve: {
      // PaddleOCR (dev-only engine, Batch 2b) imports "onnxruntime-web"; use its WASM-only build
      // (11.2 MB runtime instead of 21.9 MB with WebGPU). Nothing else imports onnxruntime-web.
      alias: [{ find: /^onnxruntime-web$/, replacement: "onnxruntime-web/wasm" }],
    },
  },
});
