import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
}

/** Kept clear of the viewport edges, and between the menu and its trigger. */
const MARGIN = 8;
const GAP = 6;

/* Portals to document.body and positions itself from the trigger's rect, so it
   overlays instead of adding to a scrolling list's layout and scroll height. */
export function PopoverMenu({ anchor, onClose, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measured after mount: where it goes depends on how tall it turned out.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();

    const below = a.bottom + GAP;
    const fitsBelow = below + m.height + MARGIN <= window.innerHeight;
    const top = fitsBelow ? below : Math.max(MARGIN, a.top - GAP - m.height);

    const left = Math.min(
      Math.max(MARGIN, a.right - m.width),
      Math.max(MARGIN, window.innerWidth - m.width - MARGIN),
    );
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    // A fixed menu can't follow its trigger on scroll, so dismiss instead. Capture
    // because the scroll may happen on a list rather than the window; passive since
    // this never calls preventDefault.
    const scrollOpts = { capture: true, passive: true } as const;
    window.addEventListener('scroll', onClose, scrollOpts);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, scrollOpts);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="menu-list menu-list-floating"
      role="menu"
      // Hidden until measured, so it never paints at 0,0.
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}
