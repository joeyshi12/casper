import { useEffect } from 'react';
import { useStore, type Toast } from '../../state/store.js';

/** Corner stack of transient notifications. Each auto-dismisses after a few seconds. */
export function Toaster() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [toast.id, dismissToast]);

  return (
    <div className={`toast toast-${toast.kind}`}>
      <span className="toast-msg">{toast.message}</span>
      <button
        className="toast-x"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
