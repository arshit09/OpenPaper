import { describe, expect, it } from 'vitest';
import { bindingLabel, eventKeys, formatBinding, matchBinding, parseBinding, type KeyLike } from './hotkeys.ts';

function ev(key: string, code: string, mods: Partial<Pick<KeyLike, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}): KeyLike {
  return { key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe('parseBinding', () => {
  it('resolves Mod per platform', () => {
    expect(parseBinding('Mod+Shift+Z')).toEqual({ ctrl: true, meta: false, alt: false, shift: true, key: 'z' });
    expect(parseBinding('Mod+Shift+Z', true)).toEqual({ ctrl: false, meta: true, alt: false, shift: true, key: 'z' });
  });
  it('handles the plus key and lone modifiers', () => {
    expect(parseBinding('+').key).toBe('+');
    expect(parseBinding('Mod++')).toMatchObject({ ctrl: true, key: '+' });
    expect(parseBinding('Alt')).toEqual({ ctrl: false, meta: false, alt: false, shift: false, key: 'Alt' });
  });
  it('rejects unknown modifiers', () => {
    expect(() => parseBinding('Hyper+K')).toThrow();
  });
});

describe('matchBinding', () => {
  it('matches letters by typed key with exact modifiers', () => {
    expect(matchBinding('Mod+Z', ev('z', 'KeyZ', { ctrlKey: true }))).toBe(true);
    expect(matchBinding('Mod+Z', ev('z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchBinding('Mod+Shift+Z', ev('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchBinding('Z', ev('z', 'KeyZ', { ctrlKey: true }))).toBe(false);
    expect(matchBinding('Mod+Z', ev('z', 'KeyZ', { metaKey: true }), true)).toBe(true);
    expect(matchBinding('Mod+Z', ev('z', 'KeyZ', { ctrlKey: true }), true)).toBe(false);
  });
  it('follows the layout for letters but falls back to the physical key', () => {
    // AZERTY: the physical Q key types "a".
    expect(matchBinding('A', ev('a', 'KeyQ'))).toBe(true);
    expect(matchBinding('Q', ev('a', 'KeyQ'))).toBe(false);
    // macOS Option changes the character; non-Latin layouts type other letters.
    expect(matchBinding('Alt+A', ev('å', 'KeyA', { altKey: true }), true)).toBe(true);
    expect(matchBinding('V', ev('м', 'KeyV'))).toBe(true);
  });
  it('matches digits and punctuation by physical key', () => {
    expect(matchBinding('Shift+1', ev('!', 'Digit1', { shiftKey: true }))).toBe(true);
    expect(matchBinding('1', ev('!', 'Digit1', { shiftKey: true }))).toBe(false);
    expect(matchBinding('5', ev('5', 'Numpad5'))).toBe(true);
    expect(matchBinding('Mod+Shift+[', ev('{', 'BracketLeft', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchBinding('Mod+\\', ev('\\', 'Backslash', { ctrlKey: true }))).toBe(true);
    expect(matchBinding('Mod+Shift+.', ev('>', 'Period', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchBinding('Ctrl+Shift+/', ev('?', 'Slash', { ctrlKey: true, shiftKey: true }))).toBe(true);
  });
  it('treats + as Shift-tolerant', () => {
    expect(matchBinding('+', ev('+', 'Equal', { shiftKey: true }))).toBe(true);
    expect(matchBinding('+', ev('+', 'NumpadAdd'))).toBe(true);
    expect(matchBinding('Mod++', ev('+', 'Equal', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchBinding('=', ev('=', 'Equal'))).toBe(true);
    expect(matchBinding('-', ev('-', 'NumpadSubtract'))).toBe(true);
  });
  it('honours tolerated modifiers', () => {
    expect(matchBinding('ArrowUp', ev('ArrowUp', 'ArrowUp', { shiftKey: true }))).toBe(false);
    expect(matchBinding('ArrowUp', ev('ArrowUp', 'ArrowUp', { shiftKey: true }), false, ['Shift'])).toBe(true);
    expect(matchBinding('Z', ev('z', 'KeyZ', { altKey: true }), false, ['Alt'])).toBe(true);
    expect(matchBinding('Escape', ev('Escape', 'Escape', { metaKey: true }), true, ['Mod'])).toBe(true);
  });
  it('matches lone modifiers while they are down', () => {
    expect(matchBinding('Alt', ev('Alt', 'AltLeft', { altKey: true }))).toBe(true);
    expect(matchBinding('Alt', ev('Alt', 'AltRight', { altKey: true, shiftKey: true }))).toBe(false);
    expect(matchBinding('Alt', ev('Alt', 'AltRight', { altKey: true, shiftKey: true }), false, ['Shift'])).toBe(true);
    expect(matchBinding('Alt', ev('a', 'KeyA', { altKey: true }))).toBe(false);
  });
  it('matches named keys and Space', () => {
    expect(matchBinding('Space', ev(' ', 'Space'))).toBe(true);
    expect(matchBinding('Ctrl+Space', ev(' ', 'Space', { ctrlKey: true }))).toBe(true);
    expect(matchBinding('Shift+Tab', ev('Tab', 'Tab', { shiftKey: true }))).toBe(true);
    expect(matchBinding('Esc', ev('Escape', 'Escape'))).toBe(true);
    expect(matchBinding('Mod+Backspace', ev('Backspace', 'Backspace', { ctrlKey: true }))).toBe(true);
  });
});

describe('eventKeys', () => {
  it('lists physical and typed tokens', () => {
    expect(eventKeys(ev('{', 'BracketLeft', { shiftKey: true }))).toEqual(['[', '{']);
    expect(eventKeys(ev('Enter', 'Enter'))).toEqual(['Enter']);
  });
});

describe('formatBinding', () => {
  it('formats for Windows and macOS', () => {
    expect(formatBinding('Mod+Shift+Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(formatBinding('Mod+Shift+Z', true)).toEqual(['⌘', '⇧', 'Z']);
    expect(formatBinding('Mod++')).toEqual(['Ctrl', '+']);
    expect(formatBinding('Alt+Drag')).toEqual(['Alt', 'Drag']);
    expect(bindingLabel('Mod+Alt+ArrowUp')).toBe('Ctrl+Alt+↑');
    expect(bindingLabel('Mod+Alt+ArrowUp', true)).toBe('⌘⌥↑');
  });
});
