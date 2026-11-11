import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useState, type ComponentType } from "react";
import { DEV_PAGES_ENABLED, loadEngineTimingPage } from "@/lib/dev/dev-pages";

/**
 * Dev-only phone timing page for the engine comparison (Phase 2c). Production guard: the same
 * compile-time switch as `?engine=paddle` (src/lib/dev/dev-pages.ts). Without it the route answers
 * "not found" and the build contains none of the page's code.
 */
export const Route = createFileRoute("/dev/engine-timing")({
  beforeLoad: () => {
    if (!DEV_PAGES_ENABLED) throw notFound();
  },
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: DevEngineTiming,
});

function DevEngineTiming() {
  const [Page, setPage] = useState<ComponentType | null>(null);
  useEffect(() => {
    let live = true;
    // Loaded in the browser only, and only when the switch is compiled in.
    void loadEngineTimingPage()?.then((m) => {
      if (live) setPage(() => m.EngineTimingPage);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!DEV_PAGES_ENABLED) return null;
  return Page ? <Page /> : <p className="p-4 text-sm">Loading…</p>;
}
