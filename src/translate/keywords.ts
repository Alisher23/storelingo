const SEPARATORS = /[,，、]/;

/** Normalizes App Store keywords: "a,b,c", no spaces after commas, no duplicates. */
export function normalizeKeywords(raw: string, exclude: string[] = []): string {
  const excluded = new Set(
    exclude.flatMap((s) => s.toLowerCase().split(/[\s,，、]+/)).filter((w) => w.length > 0),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(SEPARATORS)) {
    const keyword = part.trim().replace(/\s+/g, " ");
    if (!keyword) continue;
    const lower = keyword.toLowerCase();
    if (seen.has(lower) || excluded.has(lower)) continue;
    seen.add(lower);
    out.push(keyword);
  }
  return out.join(",");
}
