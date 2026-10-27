import { useEffect, useRef } from 'react';

/**
 * Escape closes a dialog. Controls inside it that use Escape themselves (an open dropdown) mark the
 * event handled first, and this one is then left alone.
 */
export function useEscape(onEscape: () => void, enabled = true): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
