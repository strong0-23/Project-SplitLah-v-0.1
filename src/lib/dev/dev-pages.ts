/**
 * Dev-only pages (Phase 2c phone timing page). Guarded by the same compile-time condition as the
 * dev engine switch `?engine=paddle` (`ENGINE_SWITCH_ENABLED` in src/lib/scan/engine-select.ts; a
 * test checks they always agree): only `npm run dev` and preview builds made with
 * VITE_SPLITLAH_ENGINE_SWITCH=on have them. On a Workers Builds build of `main` the variable is
 * compiled as "" (vite.config.ts), so production never has them.
 *
 * The condition is written out here rather than imported, and the page is reached only through
 * `loadEngineTimingPage`, so a production build folds the condition to `false`, drops `importPage`
 * with its dynamic import, and emits none of the page's code (same shape as engine-select.ts).
 */
export const DEV_PAGES_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_SPLITLAH_ENGINE_SWITCH === "on";

function importPage() {
  return import("../../../tools/receipt-regression/phone/EngineTimingPage");
}

/** The phone timing page module, or null when dev pages are compiled out. */
export function loadEngineTimingPage(): ReturnType<typeof importPage> | null {
  if (!DEV_PAGES_ENABLED) return null;
  return importPage();
}
