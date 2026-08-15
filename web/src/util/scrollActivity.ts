/** How long after the last scroll a scrollbar fades out. */
const IDLE_MS = 700;

const timers = new WeakMap<Element, number>();

/**
 * Reveal a scrollbar while its own element is scrolling, then fade it out again.
 *
 * One listener for the whole app rather than a handler per container: scroll events
 * do not bubble, so this captures them on the way down and marks whatever scrolled.
 * Anything scrollable is covered, including panels added later, and the class lands
 * on the element that moved rather than its ancestors.
 */
export function startScrollActivity(): void {
  document.addEventListener(
    'scroll',
    (e) => {
      // Duck-typed rather than instanceof Element, which depends on which realm's
      // globals are in scope. Document has no classList, so this also skips the
      // page itself scrolling.
      const el = e.target as Element | null;
      if (!el?.classList) return;
      el.classList.add('is-scrolling');
      clearTimeout(timers.get(el));
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove('is-scrolling'), IDLE_MS),
      );
    },
    { capture: true, passive: true },
  );
}
