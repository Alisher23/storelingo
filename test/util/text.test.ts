import { describe, expect, it } from "vitest";
import { normalizeText } from "../../src/util/text.js";

describe("normalizeText", () => {
  it("strips a leading BOM and converts CRLF and lone CR to LF", () => {
    const BOM = String.fromCharCode(0xfeff);
    expect(normalizeText(`${BOM}a\r\nb\rc\n`)).toBe("a\nb\nc\n");
  });
  it("leaves LF text and inner BOM-like characters alone", () => {
    const BOM = String.fromCharCode(0xfeff);
    expect(normalizeText(`a\nb${BOM}`)).toBe(`a\nb${BOM}`);
  });
});
