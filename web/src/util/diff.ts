// Minimal line-level diff for rendering file edits. LCS-based so unchanged
// surrounding context stays as context and only the changed lines are marked
// +/-. Pure and unit-tested.

export type DiffLine = { type: 'ctx' | 'add' | 'del'; text: string };

// Above this many cells the O(m*n) LCS table gets expensive; such a large
// replacement is better shown as a plain remove-all/add-all block anyway.
const MAX_CELLS = 400_000;

/** Line diff from oldStr to newStr. */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = oldStr.split('\n');
  const b = newStr.split('\n');
  const m = a.length;
  const n = b.length;

  if (m * n > MAX_CELLS) {
    return [
      ...a.map((t): DiffLine => ({ type: 'del', text: t })),
      ...b.map((t): DiffLine => ({ type: 'add', text: t })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: a[i++]! });
  while (j < n) out.push({ type: 'add', text: b[j++]! });
  return out;
}
