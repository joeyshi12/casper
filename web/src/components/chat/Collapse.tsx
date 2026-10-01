import { useEffect, useState, type ReactNode, type TransitionEvent } from 'react';

/* grid-rows 0fr -> 1fr animates to natural height without measuring. Children unmount
   only after the closing transition ends, so a closed fold pays nothing to render. */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const onTransitionEnd = (e: TransitionEvent) => {
    if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && !open) setMounted(false);
  };
  return (
    <div className={`collapse ${open ? 'is-open' : ''}`} onTransitionEnd={onTransitionEnd}>
      <div className="collapse-inner">{mounted ? children : null}</div>
    </div>
  );
}
