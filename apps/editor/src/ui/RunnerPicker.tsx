import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Info, Loader2, Plus } from 'lucide-react';
import type { AgentConfigInfo, AgentHarnessInfo, AgentRunner } from '@openpaper/core';
import { setState, useEditor } from '../state/store.ts';
import { allowAgy, connectAgent, loadAgentConfig, loadHarnesses, setAgentConfig } from '../sync/session.ts';
import { AgentLogo, RunnerMark } from './RunnerMark.tsx';

const EDGE = 8;
const GAP = 4;

const EFFORTS: AgentConfigInfo['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Who answers: full name in menus, short name on the chip and in prompts. */
export const RUNNER_NAMES: Record<AgentRunner, { name: string; short: string }> = {
  'claude-code': { name: 'Claude Code', short: 'Claude' },
  codex: { name: 'Codex', short: 'Codex' },
  agy: { name: 'Antigravity', short: 'agy' },
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

/** One agent that can answer, in the menu. `harness` is unset for the API key, which isn't connected anywhere. */
interface Choice {
  runner: AgentRunner;
  name: string;
  harness?: AgentHarnessInfo;
}

/**
 * Who can answer: the connected agents OpenPaper can run, and the API key when there is one. What answers
 * now is always listed, connected or not, so the menu never hides it.
 */
export function agentChoices(config: AgentConfigInfo, harnesses: AgentHarnessInfo[] | null): Choice[] {
  const choices: Choice[] = [];
  for (const h of harnesses ?? []) {
    if (h.runner && (h.connected || h.runner === config.runner)) choices.push({ runner: h.runner, name: h.label, harness: h });
  }
  if (!harnesses && config.runner !== 'api') choices.push({ runner: config.runner, name: RUNNER_NAMES[config.runner].name });
  if (config.runner === 'api' || config.keySource) choices.push({ runner: 'api', name: RUNNER_NAMES.api.name });
  return choices;
}

type Variant = 'chip' | 'agent' | 'model';

/**
 * Picks who answers and how. `chip` (beside the selection's agent button and in its prompt) and `agent`
 * (the dock) list the connected agents OpenPaper can run, the connected ones it can't (they design from
 * their own app), and last, Connect agent, which opens the settings. `model` is the dock's model and
 * effort. `claudeCodeOnly` (a live site) leaves the agents out.
 */
export function RunnerPicker({
  className,
  variant = 'chip',
  claudeCodeOnly,
}: {
  className?: string;
  variant?: Variant;
  claudeCodeOnly?: boolean;
}) {
  const config = useEditor((s) => s.agentConfig);
  const harnesses = useEditor((s) => s.harnesses);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const withModels = variant === 'model';
  const withAgents = !withModels && !claudeCodeOnly;

  useEffect(() => {
    if (!config) loadAgentConfig().catch(() => {});
  }, [config]);
  useEffect(() => {
    if (withAgents && !harnesses) loadHarnesses().catch(() => {});
  }, [withAgents, harnesses]);

  // Below the trigger, or above it when that's where the room is.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const r = trigger.current.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = menu.current;
    // The dock's pickers sit at the right of its toolbar: line the menu up with their right edge.
    const start = variant === 'chip' ? r.left : r.right - width;
    const left = Math.max(EDGE, Math.min(start, window.innerWidth - width - EDGE));
    const below = window.innerHeight - r.bottom - EDGE - GAP;
    const above = r.top - EDGE - GAP;
    setPos(
      height <= below || below >= above
        ? { top: r.bottom + GAP, left, maxHeight: below }
        : { bottom: window.innerHeight - r.top + GAP, left, maxHeight: above },
    );
  }, [open, config, harnesses, variant]);

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
  const choices = withAgents ? agentChoices(config, harnesses) : [];
  /** Connected, but they design from their own app: OpenPaper can't run them. */
  const elsewhere = withAgents ? (harnesses ?? []).filter((h) => h.connected && !h.runner) : [];
  const currentHarness = harnesses?.find((h) => h.runner === config.runner);
  const current = { ...RUNNER_NAMES[config.runner], ...(currentHarness ? { name: currentHarness.label } : {}) };
  const pick = (runner: AgentRunner) => {
    setOpen(false);
    if (runner !== config.runner) void setAgentConfig({ runner }).catch(() => {});
  };
  const connect = async (harness: AgentHarnessInfo) => {
    setConnecting(harness.id);
    const result = await connectAgent(harness.id, true);
    setConnecting(null);
    if (result?.ok && harness.runner) pick(harness.runner);
  };
  const openSettings = () => {
    setOpen(false);
    setState({ showSettings: true });
  };
  const model = modelLabel(config);

  const label = variant === 'chip' ? current.short : variant === 'agent' ? current.name : model;
  const title =
    variant === 'model'
      ? `${model} · effort ${config.effort}. Click to change.`
      : `Answered by ${current.name}. Click to pick another connected agent, or connect one.`;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`${variant === 'chip' ? 'op-runner-chip' : 'op-model-picker'}${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        title={title}
        aria-label={variant === 'model' ? `Model: ${model}` : `Agent: ${current.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          if (!open) {
            loadAgentConfig({ fresh: true }).catch(() => {}); // Fresh install and sign-in states.
            if (withAgents) loadHarnesses().catch(() => {});
          }
          setOpen(!open);
        }}
      >
        {variant !== 'model' && <RunnerMark runner={config.runner} size={variant === 'chip' ? 11 : 13} />}
        <span className={variant === 'chip' ? undefined : 'op-truncate'}>{label}</span>
        <ChevronDown size={variant === 'chip' ? 10 : 13} className={variant === 'chip' ? undefined : 'op-select-chevron'} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={withModels ? 'Model' : 'Agent'}
            className={`op-popover op-runner-menu${withModels ? ' with-models' : ''}`}
            style={pos}
            data-op-overlay-ui
            onPointerDown={(e) => e.stopPropagation()}
          >
            {withAgents && (
              <>
                {choices.length > 0 && <div className="op-runner-head">Ask with</div>}
                {choices.map(({ runner, name, harness }) => {
                  const note = runnerNote(config, runner);
                  const selected = runner === config.runner;
                  const unconnected = !!harness && !harness.connected;
                  const needsAllow = runner === 'agy' && !unconnected && !!config.agy && !config.agy.allowed;
                  return (
                    <div key={runner} className="op-runner-row">
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        className="op-runner-option"
                        disabled={!note.installed}
                        title={
                          unconnected
                            ? `${name} isn't connected: Connect adds OpenPaper to its settings.`
                            : note.installed && runnerReady(config, runner)
                              ? undefined
                              : HOW_TO[runner]
                        }
                        onClick={() => pick(runner)}
                      >
                        <span className="op-select-check">{selected && <Check size={12} />}</span>
                        <RunnerMark runner={runner} />
                        <span className="op-truncate">{name}</span>
                        {/* Not connected: the Connect button beside it says so. */}
                        {!unconnected && note.text && <span className="op-runner-note">{note.text}</span>}
                      </button>
                      {runner === 'agy' && (
                        <span className="op-runner-info" tabIndex={0} title={AGY_NOTE} aria-label={AGY_NOTE}>
                          <Info size={12} />
                        </span>
                      )}
                      {unconnected && harness && (
                        <button
                          type="button"
                          className="op-btn op-runner-allow"
                          disabled={connecting !== null}
                          title={`Add OpenPaper to ${harness.label}'s settings`}
                          onClick={() => void connect(harness)}
                        >
                          {connecting === harness.id ? <Loader2 size={11} className="op-spin" /> : 'Connect'}
                        </button>
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
                {elsewhere.length > 0 && <div className="op-runner-head">From their own apps</div>}
                {elsewhere.map((h) => (
                  <div key={h.id} className="op-runner-row">
                    <div
                      className="op-runner-option op-runner-elsewhere"
                      role="menuitem"
                      aria-disabled
                      title={`OpenPaper can't run ${h.label} itself. Ask ${h.label} to design in OpenPaper, and its work appears here live.`}
                    >
                      <span className="op-select-check" />
                      <AgentLogo id={h.id} />
                      <span className="op-truncate">{h.label}</span>
                    </div>
                  </div>
                ))}
                {(choices.length > 0 || elsewhere.length > 0) && <div className="op-menu-sep" />}
                <button type="button" role="menuitem" className="op-runner-option op-runner-connect" onClick={openSettings}>
                  <span className="op-select-check" />
                  <Plus size={14} className="op-runner-mark" />
                  <span className="op-truncate">Connect agent…</span>
                </button>
              </>
            )}
            {withModels && (
              <>
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
