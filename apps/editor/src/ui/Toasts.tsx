import { useEditor } from '../state/store.ts';

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="op-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className="op-toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}
