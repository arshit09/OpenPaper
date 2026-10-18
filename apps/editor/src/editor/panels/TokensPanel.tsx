import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { orderedTokens, resolveTokenValue, tokenCssName, TOKEN_TYPES, type TokenRecord, type TokenType } from '@openpaper/core';
import { toast, useEditor } from '../../state/store.ts';
import { command } from '../../sync/session.ts';

const LABELS: Record<TokenType, string> = {
  color: 'Colors',
  fontFamily: 'Font families',
  fontSize: 'Font sizes',
  fontWeight: 'Font weights',
  letterSpacing: 'Letter spacing',
  lineHeight: 'Line heights',
  opacity: 'Opacity',
  breakpoint: 'Breakpoints',
  container: 'Containers',
  spacing: 'Spacing',
  radius: 'Radius',
};

const PREFIX: Record<TokenType, string> = {
  color: 'color-',
  fontFamily: 'font-',
  fontSize: 'text-',
  fontWeight: 'font-weight-',
  letterSpacing: 'tracking-',
  lineHeight: 'leading-',
  opacity: 'opacity-',
  breakpoint: 'breakpoint-',
  container: 'container-',
  spacing: 'spacing-',
  radius: 'radius-',
};

function nextId(tokens: TokenRecord[]): string {
  const max = tokens.reduce((m, t) => Math.max(m, Number.parseInt(/^t:([0-9a-z]+)-/.exec(t.id)?.[1] ?? '0', 36) || 0), 0);
  return `t:${(max + 1).toString(36)}-0`;
}

export function TokensPanel() {
  const tokens = useEditor((s) => s.doc?.tokens ?? []);
  const [adding, setAdding] = useState<TokenType | null>(null);
  const [draft, setDraft] = useState({ name: '', value: '' });
  const ordered = orderedTokens(tokens);
  const save = (next: TokenRecord[]) => void command({ type: 'setTokens', tokens: next });

  return (
    <div className="op-scroll" style={{ flex: 1, padding: '8px 10px 24px' }}>
      <p className="op-label" style={{ margin: '2px 2px 10px', lineHeight: 1.5 }}>
        Tokens are CSS variables. Use them in styles as <code>var(--name)</code>. Agents read them with get_tokens.
      </p>
      {TOKEN_TYPES.map((type) => {
        const list = ordered.filter((t) => t.type === type);
        if (!list.length && adding !== type) return null;
        return (
          <div key={type} style={{ marginBottom: 14 }}>
            <div className="op-section-title" style={{ marginBottom: 4 }}>
              {LABELS[type]}
              <button className="op-icon-btn small" title={`Add ${LABELS[type].toLowerCase()}`} onClick={() => (setAdding(type), setDraft({ name: PREFIX[type], value: '' }))}>
                <Plus size={13} />
              </button>
            </div>
            {list.map((t) => (
              <div key={t.id} className="op-row" style={{ height: 30 }}>
                {type === 'color' && (
                  <span className="op-swatch">
                    <span style={{ background: resolveTokenValue(t.value, tokens) }} />
                  </span>
                )}
                <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }} title={tokenCssName(t)}>
                  {tokenCssName(t)}
                </code>
                <input
                  className="op-input"
                  style={{ width: 104, flex: 'none', fontFamily: 'var(--op-mono)', fontSize: 11 }}
                  defaultValue={t.value}
                  key={`${t.id}:${t.value}`}
                  onBlur={(e) => {
                    const value = e.currentTarget.value.trim();
                    if (value && value !== t.value) save(tokens.map((x) => (x.id === t.id ? { ...x, value } : x)));
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
                <button className="op-icon-btn small" title="Delete token" onClick={() => save(tokens.filter((x) => x.id !== t.id))}>
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {adding === type && (
              <form
                className="op-row"
                style={{ marginTop: 4 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = draft.name.replace(/^--/, '').trim();
                  if (!name || !draft.value.trim()) return;
                  if (tokens.some((t) => tokenCssName(t) === tokenCssName({ name }))) {
                    toast(`--${name} already exists — edit its value instead`);
                    return;
                  }
                  save([...tokens, { id: nextId(tokens), type, name, value: draft.value.trim() }]);
                  setAdding(null);
                }}
              >
                <input className="op-input" autoFocus placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <input className="op-input" placeholder="value" style={{ width: 90, flex: 'none' }} value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
                <button className="op-btn primary" type="submit">
                  Add
                </button>
              </form>
            )}
          </div>
        );
      })}
      {!tokens.length && adding === null && (
        <div className="op-empty">
          No tokens yet.
          <div className="op-row" style={{ justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            {(['color', 'spacing', 'radius', 'fontSize'] as TokenType[]).map((t) => (
              <button key={t} className="op-btn outline" onClick={() => (setAdding(t), setDraft({ name: PREFIX[t], value: '' }))}>
                <Plus size={13} /> {LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
