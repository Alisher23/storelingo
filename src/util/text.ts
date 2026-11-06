/** Normalizes text to the on-disk form: no leading BOM, LF line endings (CRLF and lone CR become LF). */
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}
