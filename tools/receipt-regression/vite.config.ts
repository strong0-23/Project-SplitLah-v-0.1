import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Separate dev-only entry. Dataset files are read via the browser picker, never served by Vite.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL("../../src/lib", import.meta.url)), fileURLToPath(new URL(".", import.meta.url))],
      deny: ["**/receipt-regression.local/**", "**/.git/**", "**/.env*"],
    },
  },
  plugins: [{ name: "local-harness-only", apply: "build", buildStart() { throw new Error("Receipt harness is dev-only. Use npm.cmd run receipts:dev."); } }],
});
