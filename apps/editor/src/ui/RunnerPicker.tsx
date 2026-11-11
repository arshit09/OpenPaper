import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Info } from 'lucide-react';
import type { AgentConfigInfo, AgentRunner } from '@openpaper/core';
import { useEditor } from '../state/store.ts';
import { allowAgy, loadAgentConfig, setAgentConfig } from '../sync/session.ts';
import { RunnerMark } from './RunnerMark.tsx';

const EDGE = 8;
const GAP = 4;

const EFFORTS: AgentConfigInfo['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Who answers: full name in menus, short name on the chip and in prompts. */
export const RUNNER_NAMES: Record<AgentRunner, { name: string; short: string }> = {
  'claude-code': { name: 'Claude Code', short: 'Claude' },
  codex: { name: 'Codex', short: 'Codex' },
  agy: { name: 'Antigravity (agy)', short: 'agy' },
  api: { name: 'Claude API key', short: 'Claude' },
};

/** Why agy needs a one-time permission, for its (i) notes. */
export const AGY_NOTE =
  "Antigravity can't ask for permission when OpenPaper runs it in the background, so it needs one allow rule, mcp(openpaper_openpaper/*), " +
  'in ~/.gemini/antigravity-cli/settings.json. Allow adds it for you. The rule only covers OpenPaper’s design tools inside OpenPaper’s own agy ' +
  'workspace, and shell, file and browser tools stay blocked there. Remove the line from that file to take it back.';

/** Whether a runner can take a message now. */
export function runnerReady(config: AgentConfigInfo, runner = config.runner): boolean {
  switch (runner) {
    case 'api':
      return config.keySource !== null;
    case 'claude-code':
      return !!config.claudeCode?.loggedIn;
    case 'codex':
      return !!config.codex?.loggedIn;
    case 'agy':
      return !!config.agy?.allowed;
  }
}

/** Short status beside a runner in the menu: what's missing, or its plan. */
function runnerNote(config: AgentConfigInfo, runner: AgentRunner): { text: string; installed: boolean } {
  switch (runner) {
    case 'api':
      return { text: config.keySource ? '' : 'No key', installed: true };
    case 'claude-code':
      return { text: !config.claudeCode ? 'Not installed' : !config.claudeCode.loggedIn ? 'Sign in' : (config.claudeCode.plan ?? ''), installed: !!config.claudeCode };
    case 'codex':
      return { text: !config.codex ? 'Not installed' : !config.codex.loggedIn ? 'Sign in' : (config.codex.plan ?? ''), installed: !!config.codex };
    case 'agy':
      return { text: !config.agy ? 'Not installed' : '', installed: !!config.agy };
  }
}

const HOW_TO: Record<AgentRunner, string> = {
  'claude-code': 'Install Claude Code from claude.com/claude-code, then run `claude auth login`.',
  codex: 'Install the Codex CLI from developers.openai.com/codex, then run `codex login`.',
  agy: 'Install the Antigravity CLI (agy) from antigravity.google and sign in.',
  api: 'Add an Anthropic API key in the agent settings.',
};

/** The selected model's name, for a trigger. */
function modelLabel(config: AgentConfigInfo): string {
  return config.models.find((m) => m.id === config.model)?.label ?? (config.model || 'Default model');
}

/**
 * Picks which coding agent answers: Claude Code, Codex or Antigravity (and the API key runner when one is
 * set up). It changes the agent's runner for every chat. The `chip` is the tiny one beside the selection's
 * agent button; `model` is the agent dock's, whose trigger names the model and whose menu also picks the
 * model and effort. `claudeCodeOnly` (a live site) leaves the runners out.
 */
export function RunnerPicker({
  className,
  variant = 'chip',
  claudeCodeOnly,
}: {
  className?: string;
  variant?: 'chip' | 'model';
  claudeCodeOnly?: boolean;
}) {
  const config = useEditor((s) => s.agentConfig);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!config) loadAgentConfig().catch(() => {});
  }, [config]);

  // Below the chip, or above it when that's where the room is.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const r = trigger.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menu.current;
    // The dock's picker sits at the right of its toolbar: line the menu up with its right edge.
    const start = variant === 'model' ? r.right - width : r.left;
    const left = Math.max(EDGE, Math.min(start, window.innerWidth - width - EDGE));
    const below = window.innerHeight - r.bottom - EDGE - GAP;
    const above = r.top - EDGE - GAP;
    setPos(
      height <= below || below >= above
        ? { top: r.bottom + GAP, left, maxHeight: below }
        : { bottom: window.innerHeight - r.top + GAP, left, maxHeight: above },
    );
  }, [open, config, variant]);

  // Close on a press outside, Escape, scrolling, resizing or leaving the window.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const onClose = () => setOpen(false);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [open]);

  if (!config) return null;
  const runners: AgentRunner[] = claudeCodeOnly
    ? []
    : ['claude-code', 'codex', 'agy', ...(config.runner === 'api' || config.keySource ? (['api'] as const) : [])];
  const current = RUNNER_NAMES[config.runner];
  const pick = (runner: AgentRunner) => {
    setOpen(false);
    if (runner !== config.runner) void setAgentConfig({ runner }).catch(() => {});
  };
  const withModels = variant === 'model';
  const model = modelLabel(config);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${withModels ? 'op-model-picker' : 'op-runner-chip'}${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        title={
          withModels
            ? `${current.name} · ${model} · effort ${config.effort}. Click to change.`
            : `Answered by ${current.name}. Click to pick Claude Code, Codex or Antigravity.`
        }
        aria-label={withModels ? `Agent: ${current.name}, ${model}` : `Agent: ${current.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          if (!open) loadAgentConfig().catch(() => {}); // Fresh install and sign-in states.
          setOpen(!open);
        }}
      >
        <RunnerMark runner={config.runner} size={withModels ? 13 : 11} />
        <span className={withModels ? 'op-truncate' : undefined}>{withModels ? model : current.short}</span>
        <ChevronDown size={withModels ? 13 : 10} className={withModels ? 'op-select-chevron' : undefined} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label="Agent"
            className={`op-popover op-runner-menu${withModels ? ' with-models' : ''}`}
            style={pos}
            data-op-overlay-ui
            onPointerDown={(e) => e.stopPropagation()}
          >
            {runners.length > 0 && <div className="op-runner-head">Ask with</div>}
            {runners.map((runner) => {
              const note = runnerNote(config, runner);
              const selected = runner === config.runner;
              const needsAllow = runner === 'agy' && !!config.agy && !config.agy.allowed;
              return (
                <div key={runner} className="op-runner-row">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="op-runner-option"
                    disabled={!note.installed}
                    title={note.installed ? (runnerReady(config, runner) ? undefined : HOW_TO[runner]) : HOW_TO[runner]}
                    onClick={() => pick(runner)}
                  >
                    <span className="op-select-check">{selected && <Check size={12} />}</span>
                    <RunnerMark runner={runner} />
                    <span className="op-truncate">{RUNNER_NAMES[runner].name}</span>
                    {note.text && <span className="op-runner-note">{note.text}</span>}
                  </button>
                  {runner === 'agy' && (
                    <span className="op-runner-info" tabIndex={0} title={AGY_NOTE} aria-label={AGY_NOTE}>
                      <Info size={12} />
                    </span>
                  )}
                  {needsAllow && (
                    <button
                      type="button"
                      className="op-btn op-runner-allow"
                      title="Add the allow rule to agy's settings and use Antigravity"
                      onClick={async () => {
                        await allowAgy();
                        pick('agy');
                      }}
                    >
                      Allow
                    </button>
                  )}
                </div>
              );
            })}
            {withModels && (
              <>
                {runners.length > 0 && <div className="op-menu-sep" />}
                <div className="op-runner-head">Model</div>
                {config.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={m.id === config.model}
                    className="op-runner-option"
                    onClick={() => {
                      setOpen(false);
                      if (m.id !== config.model) void setAgentConfig({ model: m.id }).catch(() => {});
                    }}
                  >
                    <span className="op-select-check">{m.id === config.model && <Check size={12} />}</span>
                    <span className="op-truncate">{m.label}</span>
                  </button>
                ))}
                {/* agy's model ids carry their own effort. */}
                {config.runner !== 'agy' && (
                  <>
                    <div className="op-runner-head">Effort</div>
                    <div className="op-effort" role="group" aria-label="Effort">
                      {EFFORTS.map((effort) => (
                        <button
                          key={effort}
                          type="button"
                          role="menuitemradio"
                          aria-checked={effort === config.effort}
                          onClick={() => {
                            if (effort !== config.effort) void setAgentConfig({ effort }).catch(() => {});
                          }}
                        >
                          {effort}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
