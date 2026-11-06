/** Number of Unicode code points — the unit Google Play and App Store limits use. */
export function countChars(text: string): number {
  return [...text].length;
}
