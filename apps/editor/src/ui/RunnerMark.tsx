import type { CSSProperties } from 'react';
import type { AgentRunner } from '@openpaper/core';
import { AGENT_LOGOS, type AgentLogoId, type AgentLogoPath } from './agentLogos.ts';

/** Each connectable agent's logo, by its connect id (packages/server/src/harness.ts). */
const HARNESS_LOGOS: Record<string, AgentLogoId> = {
  'claude-code': 'claude-code',
  'claude-desktop': 'claude',
  cursor: 'cursor',
  vscode: 'vscode',
  codex: 'codex',
  windsurf: 'windsurf',
  'gemini-cli': 'gemini-cli',
  antigravity: 'antigravity',
  opencode: 'opencode',
  'copilot-cli': 'copilot',
};

/** Who answers: Claude Code's mark for Claude Code, Claude's for the API key. */
const RUNNER_LOGOS: Record<AgentRunner, AgentLogoId> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  agy: 'antigravity',
  api: 'claude',
};

interface MarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
}

function Logo({ logo, size = 14, className, style }: MarkProps & { logo: AgentLogoId | undefined }) {
  if (!logo) return <span className={`op-runner-mark${className ? ` ${className}` : ''}`} style={{ width: size, height: size, ...style }} aria-hidden />;
  const mark: AgentLogoPath = AGENT_LOGOS[logo];
  return (
    <svg width={size} height={size} viewBox={mark.viewBox} className={`op-runner-mark${className ? ` ${className}` : ''}`} style={style} aria-hidden>
      <path d={mark.d} fill="currentColor" fillRule={mark.evenodd ? 'evenodd' : undefined} />
    </svg>
  );
}

/** The logo of the coding agent that answers: Claude Code, Codex, Antigravity or Claude (API key). */
export function RunnerMark({ runner, ...props }: MarkProps & { runner: AgentRunner }) {
  return <Logo logo={RUNNER_LOGOS[runner]} {...props} />;
}

/** The logo of an agent OpenPaper connects to (Claude Code, Cursor, VS Code…), by its connect id. */
export function AgentLogo({ id, ...props }: MarkProps & { id: string }) {
  return <Logo logo={HARNESS_LOGOS[id]} {...props} />;
}
