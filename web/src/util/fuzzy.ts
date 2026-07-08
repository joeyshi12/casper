/**
 * Tiny subsequence fuzzy matcher. Returns a score (higher = better) or -1 if
 * `query` isn't a subsequence of `text`. Consecutive and word-start matches
 * score higher, so "hc" ranks "health check" above "historic cache".
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score += 1;
    if (found === prevMatch + 1) score += 3; // consecutive
    if (found === 0 || /\s|[-_/.]/.test(t[found - 1] ?? '')) score += 2; // word start
    prevMatch = found;
    ti = found + 1;
  }
  return score;
}
