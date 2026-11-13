import { describe, expect, it } from "vitest";
import { sanitizeText } from "./use-bill";

describe("sanitizeText", () => {
  it("removes exactly U+0000–U+001F and U+007F, for every UTF-16 code unit", () => {
    const wrong: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      const control = c <= 0x1f || c === 0x7f;
      if (sanitizeText(`a${ch}b`, 10) !== (control ? "ab" : `a${ch}b`)) wrong.push(c);
    }
    expect(wrong).toEqual([]);
  });

  it("keeps emoji (surrogate pairs) and trims to the limit after stripping", () => {
    expect(sanitizeText("Tea\u0000\t🍵\u007f\n", 80)).toBe("Tea🍵");
    expect(sanitizeText("\u0001abcdef", 3)).toBe("abc");
  });
});
