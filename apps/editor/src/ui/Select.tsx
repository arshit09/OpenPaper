import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/** `icon` sits before the label, in the list and on the trigger. */
export type SelectOption<T extends string> = { value: T; label: string; icon?: ReactNode };

const EDGE = 8;
const GAP = 4;
const MAX_HEIGHT = 320;

/**
 * A dropdown drawn by the editor in place of the browser's native <select>. The list opens in a
 * portal so docked or scrolling panels can't clip it, and focus stays on the trigger (a combobox)
 * while the arrow keys, Enter, Escape and type-ahead move through the options.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  className,
  style,
  title,
  disabled,
  placeholder = '',
  'aria-label': ariaLabel,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  style?: CSSProperties;
  title?: string;
  disabled?: boolean;
  /** Shown when `value` matches no option (mixed selections, unset values). */
  placeholder?: string;
  'aria-label'?: string;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const selectedIndex = options.findIndex((o) => o.value === value);

  const show = () => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };
  const choose = (i: number) => {
    setOpen(false);
    const option = options[i];
    if (option && option.value !== value) onChange(option.value);
  };

  // Drop the list below the trigger, or above it when that's where the room is.
  useLayoutEffect(() => {
    if (!open) return;
    const r = triggerRef.current!.getBoundingClientRect();
    const menu = menuRef.current!;
    const height = Math.min(menu.scrollHeight + 2, MAX_HEIGHT);
    const width = Math.max(r.width, menu.offsetWidth);
    const below = window.innerHeight - r.bottom - EDGE - GAP;
    const above = r.top - EDGE - GAP;
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));
    setPos(
      height <= below || below >= above
        ? { top: r.bottom + GAP, left, minWidth: r.width, maxHeight: Math.min(MAX_HEIGHT, below) }
        : { bottom: window.innerHeight - r.top + GAP, left, minWidth: r.width, maxHeight: Math.min(MAX_HEIGHT, above) },
    );
  }, [open]);

  // Keep the highlighted option in view as the arrow keys move it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const item = menu?.children[active] as HTMLElement | undefined;
    if (!menu || !item) return;
    if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop - GAP;
    else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight + GAP;
  }, [open, active, pos]);

  // Close on a press outside, a scroll or resize that would strand the list, or leaving the window.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onScroll = (e: Event) => !menuRef.current?.contains(e.target as Node) && setOpen(false);
    const onClose = () => setOpen(false);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [open]);

  /** Type-ahead: the next option whose label starts with what was just typed. */
  const findTyped = (key: string, from: number) => {
    const t = typed.current;
    const now = Date.now();
    t.text = now - t.at < 700 ? t.text + key.toLowerCase() : key.toLowerCase();
    t.at = now;
    // Pressing one letter repeatedly cycles through the options starting with it.
    const cycling = [...t.text].every((c) => c === t.text.charAt(0));
    const query = cycling ? t.text.charAt(0) : t.text;
    for (let k = cycling ? 1 : 0; k <= options.length; k++) {
      const i = (from + k) % options.length;
      if (options[i]?.label.toLowerCase().startsWith(query)) return i;
    }
    return -1;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const { key } = e;
    const char = key.length === 1 && key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
    let handled = true;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') show();
      else if (char) {
        const i = findTyped(key, Math.max(0, selectedIndex));
        if (i !== -1) choose(i);
      } else handled = false;
    } else if (key === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
    else if (key === 'ArrowUp') e.altKey ? setOpen(false) : setActive((a) => Math.max(0, a - 1));
    else if (key === 'Home' || key === 'PageUp') setActive(0);
    else if (key === 'End' || key === 'PageDown') setActive(options.length - 1);
    else if (key === 'Enter' || key === ' ') choose(active);
    else if (key === 'Escape') setOpen(false);
    else if (char) {
      const i = findTyped(key, active);
      if (i !== -1) setActive(i);
    } else {
      if (key === 'Tab') setOpen(false);
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-label={ariaLabel}
        className={`op-input op-select${className ? ` ${className}` : ''}`}
        style={style}
        title={title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {options[selectedIndex]?.icon}
        <span className="op-truncate">{options[selectedIndex]?.label ?? placeholder}</span>
        <ChevronDown size={12} className="op-select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={`${id}-list`}
            role="listbox"
            className="op-popover op-select-menu op-scroll"
            style={pos}
            data-op-overlay-ui
            // Keep focus (and the keyboard) on the trigger while picking with the mouse.
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === selectedIndex}
                className="op-select-option"
                data-active={i === active || undefined}
                onPointerMove={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="op-select-check">{i === selectedIndex && <Check size={12} />}</span>
                {o.icon}
                <span className="op-truncate">{o.label}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
