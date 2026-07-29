/**
 * Props for an inline transcript image that should only load when scrolled near.
 *
 * loading="lazy" alone isn't enough: the browser only defers images it believes
 * are offscreen, and an <img> with no width/height is zero pixels tall until its
 * bytes arrive. A transcript full of unsized images therefore stacks inside the
 * viewport and every one of them is fetched at once, which also starves the
 * session's own requests for connection slots. The stylesheet gives an image
 * without [data-loaded] a placeholder box so the ones further down the
 * transcript are genuinely out of view; this marks each image once its bytes
 * land so the box gives way to the real dimensions.
 */
export const lazyImageProps = {
  loading: 'lazy' as const,
  decoding: 'async' as const,
  // Cached images can finish before React attaches onLoad, so check on mount too.
  ref: (el: HTMLImageElement | null) => {
    if (el?.complete) el.dataset.loaded = '';
  },
  onLoad: (e: { currentTarget: HTMLImageElement }) => {
    e.currentTarget.dataset.loaded = '';
  },
};
