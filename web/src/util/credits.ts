const creditFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** A credit count as kiro shows one: two decimals, and never a bare 0 for a small cost. */
export function formatCredits(n: number): string {
  if (n > 0 && n < 0.01) return '<0.01';
  return creditFmt.format(n);
}
