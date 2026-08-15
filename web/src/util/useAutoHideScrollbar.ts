import { useEffect, useRef } from 'react';

/** How long after the last scroll the scrollbar fades out. */
const IDLE_MS = 700;

/**
 * Reveals a scroll container's scrollbar while it moves, then fades it out. Pair with
 * the .scroll-autohide class, which keeps the scrollbar's width reserved so showing
 * and hiding never reflows the content.
 *
 * classList rather than state: this runs on every scroll frame, and a re-render per
 * frame would be wasted on a list that has not changed.
 */
export function useAutoHideScrollbar<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const timer = useRef<number | undefined>(undefined);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.add('is-scrolling');
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => el.classList.remove('is-scrolling'), IDLE_MS);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return { ref, onScroll };
}
