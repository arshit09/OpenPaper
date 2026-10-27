import { useEffect, useRef, useState } from 'react';

/**
 * Swatch that opens the native colour picker. While the picker is open the input holds the picked
 * colour itself (bound to the stored value it would snap back on every move), and the pick is
 * committed once, when the picker closes or the swatch loses focus.
 */
export function ColorSwatch({
  hex,
  color,
  title,
  onPreview,
  onCommit,
  onCancel,
}: {
  /** `#rrggbb` the picker opens at. */
  hex: string;
  /** What the swatch shows when nothing is being picked (any CSS colour). */
  color: string;
  title?: string;
  /** Every move of the picker, before it's committed. */
  onPreview?: (hex: string) => void;
  /** The picked colour; the swatch keeps showing it until a returned promise settles. */
  onCommit: (hex: string) => void | Promise<unknown>;
  /** The picker closed on the colour it opened at (or was cancelled): drop any preview. */
  onCancel?: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const pickedRef = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** The colour the picker opened at. */
  const openedAt = useRef(hex);
  const handlers = useRef({ onCommit, onCancel });
  handlers.current = { onCommit, onCancel };

  const finish = () => {
    const value = pickedRef.current;
    if (value === null) return;
    pickedRef.current = null;
    // A cancelled picker can report its starting colour, which for a token or translucent fill is only
    // the stand-in `hex`: committing it would replace the real value.
    if (value.toLowerCase() === openedAt.current.toLowerCase()) {
      setPicked(null);
      handlers.current.onCancel?.();
      return;
    }
    void Promise.resolve(handlers.current.onCommit(value))
      .catch(() => {})
      .finally(() => {
        if (pickedRef.current === null) setPicked(null);
      });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // The native `change` event fires when the picker closes with a new colour (React's onChange is `input`).
  useEffect(() => {
    const el = input.current!;
    const onChange = () => finishRef.current();
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);

  return (
    <label className="op-swatch" style={{ cursor: 'pointer' }} title={title}>
      <span style={{ background: picked ?? color }} />
      <input
        ref={input}
        type="color"
        aria-label={title ?? 'Pick a colour'}
        value={picked ?? hex}
        onChange={(e) => {
          if (pickedRef.current === null) openedAt.current = hex;
          pickedRef.current = e.target.value;
          setPicked(e.target.value);
          onPreview?.(e.target.value);
        }}
        onBlur={finish}
        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
      />
    </label>
  );
}
