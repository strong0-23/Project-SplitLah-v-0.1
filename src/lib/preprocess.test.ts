import { describe, expect, it } from "vitest";
import { flattenIllumination, grayscale, type Pixels } from "./preprocess";

function pixels(colours: number[][]): Pixels {
  return { width: colours.length, height: 1, data: new Uint8ClampedArray(colours.flatMap(c => [...c, 255])) };
}

const reds = (image: Pixels) => Array.from(image.data).filter((_, index) => index % 4 === 0);

describe("diagnostic preprocessing channels", () => {
  it("preserves the existing luminance and lighting math by default", () => {
    // Three primaries share the same neighbourhood: mean luminance = 85,
    // denominator = 86. The original Float32 computation rounds to these bytes.
    const primary = pixels([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    expect(reds(flattenIllumination(primary))).toEqual([208, 255, 79]);
    expect(Array.from(flattenIllumination(primary).data)).toEqual([
      208, 208, 208, 255, 255, 255, 255, 255, 79, 79, 79, 255,
    ]);
    expect(reds(grayscale(primary))).toEqual([76, 150, 29]);
  });

  it("keeps default output byte-identical to explicit luminance for both radii", () => {
    const image = pixels(Array.from({ length: 53 }, (_, i) => [(i * 17) % 256, (i * 61) % 256, (i * 113) % 256]));
    for (const radius of [undefined, 3]) {
      expect(flattenIllumination(image, radius).data).toEqual(flattenIllumination(image, radius, "luminance").data);
    }
    expect(grayscale(image).data).toEqual(grayscale(image, "luminance").data);
  });

  it("can reduce cyan mark contrast while retaining a dark neutral stroke", () => {
    // Synthetic paper with one cyan mark and one dark printed stroke. This is
    // a pixel-level rationale for an experiment, not a claim of OCR accuracy.
    const image = pixels([...Array.from({ length: 9 }, () => [230, 230, 230]), [70, 180, 220], [20, 20, 20]]);
    const luminance = reds(grayscale(image));
    const blue = reds(grayscale(image, "blue"));
    expect(blue[0]! - blue[9]!).toBeLessThan(luminance[0]! - luminance[9]!);
    expect(blue[10]).toBe(luminance[10]);
    const flattened = reds(flattenIllumination(image));
    const flattenedBlue = reds(flattenIllumination(image, undefined, "blue"));
    expect(flattenedBlue[9]).toBeGreaterThan(flattened[9]!);
    expect(flattenedBlue[10]).toBeLessThan(40);
  });

  it.each(["luminance", "blue"] as const)("does not mutate the source or resize it for %s", channel => {
    const image: Pixels = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 30, 1, 10, 220, 30, 2, 40, 20, 250, 3, 60, 80, 90, 4]) };
    const before = image.data.slice();
    for (const output of [grayscale(image, channel), flattenIllumination(image, undefined, channel)]) {
      expect(output.width).toBe(2);
      expect(output.height).toBe(2);
      expect(output.data).not.toBe(image.data);
      expect(output.data.length).toBe(image.data.length);
      for (let p = 0; p < output.data.length; p += 4) {
        expect(output.data[p]).toBe(output.data[p + 1]);
        expect(output.data[p]).toBe(output.data[p + 2]);
        expect(output.data[p + 3]).toBe(255);
      }
    }
    expect(image.data).toEqual(before);
  });
});
