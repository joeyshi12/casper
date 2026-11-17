import { useEffect, useRef, useState } from 'react';

/** How long a list stays still before its scrollbar fades out. */
const SCROLLBAR_IDLE_MS = 1000;

/**
 * For a `.fade-scroll` element: shows its scrollbar while it scrolls and fades it out once it
 * has been still for a second, and reports whether it is scrolled down, which draws a line
 * under a header. The class is set on the element, so scrolling does not re-render.
 */
export function useFadingScrollbar() {
  const [scrolled, setScrolled] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    setScrolled(el.scrollTop > 0);
    el.classList.add('is-scrolling');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => el.classList.remove('is-scrolling'), SCROLLBAR_IDLE_MS);
  };
  return { scrolled, onScroll };
}
