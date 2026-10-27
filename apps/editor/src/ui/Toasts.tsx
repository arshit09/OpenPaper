import { useEditor } from '../state/store.ts';

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  // Float above the agent dock instead of covering the prompt.
  const dock = toasts.length ? document.querySelector('.op-dock')?.getBoundingClientRect() : undefined;
  const bottom = dock ? Math.max(16, window.innerHeight - dock.top + 8) : 16;
  return (
    <div className="op-toast-stack" role="status" aria-live="polite" style={{ bottom }}>
      {toasts.map((t) => (
        <div key={t.id} className="op-toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
