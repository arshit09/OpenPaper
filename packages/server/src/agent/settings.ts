import { readFile } from 'node:fs/promises';
import { loadConfigWithSource } from '@anthropic-ai/sdk/core/credentials';
import type { AgentConfigInfo } from '@openpaper/core';
import { writeFileAtomic } from '../fs-utils.ts';
import { AGENT_MODELS } from './agent.ts';
import { claudeCodeStatus, type ClaudeCodeStatus } from './claude-code.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export type Runner = AgentConfigInfo['runner'];
const RUNNERS: Runner[] = ['api', 'claude-code'];

interface StoredConfig {
  agent?: { runner?: Runner; apiKey?: string; model?: string; effort?: Effort };
  [key: string]: unknown;
}

/**
 * Settings for the built-in agent, kept in `<home>/config.json` (owner-only permissions).
 * The API key never leaves the server: editors only learn whether one is configured.
 */
export class AgentSettings {
  readonly defaults = { runner: 'api' as Runner, model: 'claude-opus-5-5', effort: 'high' as Effort };

  constructor(
    private readonly path: string,
    /** Override for tests. */
    private readonly probeClaudeCode: () => Promise<ClaudeCodeStatus | null> = () => claudeCodeStatus()
  ) {}

  private async read(): Promise<StoredConfig> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredConfig;
    } catch {
      return {};
    }
  }

  async resolved(): Promise<{ runner: Runner; apiKey: string | undefined; model: string; effort: Effort }> {
    const cfg = (await this.read()).agent ?? {};
    // Without a stored key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    return {
      runner: RUNNERS.includes(cfg.runner as Runner) ? cfg.runner! : this.defaults.runner,
      apiKey: cfg.apiKey || undefined,
      model: AGENT_MODELS.some((m) => m.id === cfg.model) ? cfg.model! : this.defaults.model,
      effort: EFFORTS.includes(cfg.effort as Effort) ? cfg.effort! : this.defaults.effort,
    };
  }

  async info(): Promise<AgentConfigInfo> {
    const r = await this.resolved();
    const [keySource, claudeCode] = await Promise.all([this.keySource(r.apiKey), this.probeClaudeCode()]);
    return { runner: r.runner, keySource, claudeCode, model: r.model, effort: r.effort, models: AGENT_MODELS };
  }

  private async keySource(apiKey: string | undefined): Promise<AgentConfigInfo['keySource']> {
    if (apiKey) return 'settings';
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'environment';
    return (await hasSdkProfile()) ? 'profile' : null;
  }

  async update(patch: { runner?: Runner; apiKey?: string | null; model?: string; effort?: Effort }): Promise<void> {
    const cfg = await this.read();
    const agent = { ...(cfg.agent ?? {}) };
    if (patch.runner && RUNNERS.includes(patch.runner)) agent.runner = patch.runner;
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey?.trim();
      if (key) agent.apiKey = key;
      else delete agent.apiKey;
    }
    if (patch.model && AGENT_MODELS.some((m) => m.id === patch.model)) agent.model = patch.model;
    if (patch.effort && EFFORTS.includes(patch.effort)) agent.effort = patch.effort;
    await writeFileAtomic(this.path, JSON.stringify({ ...cfg, agent }, null, 2), 0o600);
  }
}

/** Whether the SDK's default credential chain has an `ant auth login` profile (or workload federation) to use. */
async function hasSdkProfile(): Promise<boolean> {
  try {
    return (await loadConfigWithSource()) !== null;
  } catch {
    return false; // An unreadable profile: a request would fail too, so ask for a key.
  }
}
