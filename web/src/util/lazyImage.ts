/**
 * Props for a transcript image that should only load when scrolled near.
 *
 * loading="lazy" alone isn't enough: an <img> with no dimensions is zero pixels
 * tall until its bytes arrive, so every image stacks inside the viewport and all
 * of them fetch at once. The stylesheet holds a placeholder box while an image
 * lacks [data-loaded]; this sets it once the bytes land.
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
