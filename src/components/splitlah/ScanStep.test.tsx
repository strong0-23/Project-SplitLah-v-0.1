/**
 * Scan screen when the browser blocks canvas read-back (fingerprinting protection, e.g. Zen /
 * Firefox resistFingerprinting): the user sees the explanation, never a black preview.
 * Mocked canvases and a synthetic file only.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillProvider } from "@/hooks/use-bill";
import { CANVAS_BLOCKED_MESSAGE } from "@/lib/scan";
import { setCanvasReadbackCheckedForTests } from "@/lib/scan/canvas";
import { ScanStep } from "./ScanStep";

/** A canvas whose read-back returns zeros, as a protected browser does. */
function blockedCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect: vi.fn(),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
    }),
  };
}

describe("ScanStep: canvas read-back blocked", () => {
  beforeEach(() => {
    localStorage.clear();
    setCanvasReadbackCheckedForTests(false);
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "canvas"
        ? (blockedCanvas() as unknown as HTMLCanvasElement)
        : original(tag)) as typeof document.createElement);
    vi.stubGlobal("createImageBitmap", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the message instead of a preview, and again when Read receipt is pressed", async () => {
    render(
      <BillProvider>
        <ScanStep go={() => undefined} />
      </BillProvider>,
    );
    const file = new File(["synthetic"], "receipt.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload a receipt image"), {
      target: { files: [file] },
    });

    expect(await screen.findByText(CANVAS_BLOCKED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByAltText("Selected receipt")).not.toBeInTheDocument();

    const probes = () =>
      vi.mocked(document.createElement).mock.calls.filter(([tag]) => tag === "canvas").length;
    expect(probes()).toBe(1); // the preview's check

    fireEvent.click(screen.getByRole("button", { name: "Read receipt" }));
    await waitFor(() => expect(probes()).toBe(2)); // the scan path ran its own check
    expect(await screen.findByText(CANVAS_BLOCKED_MESSAGE)).toBeInTheDocument();
    // Shown as is: no "try another photo" suffix, since another photo won't help.
    expect(screen.queryByText(/try another photo/)).not.toBeInTheDocument();
    expect(screen.queryByAltText("Selected receipt")).not.toBeInTheDocument();
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Enter items manually/ })).toBeInTheDocument();
  });
});
