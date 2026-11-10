import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";
import { setCanvasReadbackCheckedForTests } from "@/lib/scan/canvas";

// jsdom has no real canvas and tests mock it with fixed pixels, which the canvas read-back probe
// (src/lib/scan/canvas.ts) would rightly reject. Tests of the probe itself turn this off.
beforeEach(() => setCanvasReadbackCheckedForTests(true));

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
