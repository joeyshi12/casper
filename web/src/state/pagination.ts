// The [offset, offset+limit) window for the next older page to fetch, given how
// many older items remain before the loaded window. The page nearest the loaded
// window is fetched first (scrolling up walks backwards toward index 0). Pure so
// the windowing is unit-testable. Returns limit 0 when nothing older remains.
export function olderPageRequest(
  remainingOlder: number,
  pageSize: number,
): { offset: number; limit: number } {
  if (remainingOlder <= 0) return { offset: 0, limit: 0 };
  const offset = Math.max(0, remainingOlder - pageSize);
  return { offset, limit: remainingOlder - offset };
}
