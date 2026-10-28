import { readFile } from 'node:fs/promises';
import { loadConfigWithSource } from '@anthropic-ai/sdk/core/credentials';
import type { AgentConfigInfo, AgentRunner } from '@openpaper/core';
import { writeFileAtomic } from '../fs-utils.ts';
import { AGENT_MODELS } from './agent.ts';
import { agyModels, agyStatus, allowAgyDesignTools, type AgyStatus } from './agy.ts';
import { claudeCodeStatus, type ClaudeCodeStatus } from './claude-code.ts';
import { codexConfiguredModel, codexModels, codexStatus, type CodexStatus } from './codex.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export type Runner = AgentRunner;
const RUNNERS: Runner[] = ['api', 'claude-code', 'codex', 'agy'];

type ModelList = Array<{ id: string; label: string }>;

interface StoredConfig {
  agent?: { runner?: Runner; apiKey?: string; model?: string; codexModel?: string; agyModel?: string; effort?: Effort };
  [key: string]: unknown;
}

/** What OpenPaper asks the installed coding agents (overridable for tests). */
export interface AgentProbes {
  claudeCode(): Promise<ClaudeCodeStatus | null>;
  codex(): Promise<CodexStatus | null>;
  agy(): Promise<AgyStatus | null>;
  codexModels(): Promise<ModelList>;
  /** The model the user's own Codex config picks. */
  codexDefault(): Promise<string | null>;
  agyModels(): Promise<ModelList>;
  /** Let agy run OpenPaper's design tools (adds an allow rule to its settings). */
  allowAgy(): Promise<void>;
}

const DEFAULT_PROBES: AgentProbes = {
  claudeCode: () => claudeCodeStatus(),
  codex: () => codexStatus(),
  agy: () => agyStatus(),
  codexModels,
  codexDefault: codexConfiguredModel,
  agyModels: () => agyModels(),
  allowAgy: () => allowAgyDesignTools(),
};

/** A Codex or agy model id ("" = its own default). It becomes a CLI argument, so it can't look like a flag. */
const cliModel = (id: unknown): string => (typeof id === 'string' && /^\w[\w.:/-]{0,99}$/.test(id) ? id : '');

/**
 * Settings for the built-in agent, kept in `<home>/config.json` (owner-only permissions).
 * The API key never leaves the server: editors only learn whether one is configured.
 */
export class AgentSettings {
  readonly defaults = { runner: 'api' as Runner, model: 'claude-opus-5-5', effort: 'high' as Effort };
  private readonly probes: AgentProbes;
  private agyModelCache: ModelList = [];

  constructor(
    private readonly path: string,
    /** Overrides for tests. */
    probes: Partial<AgentProbes> = {}
  ) {
    this.probes = { ...DEFAULT_PROBES, ...probes };
  }

  private async read(): Promise<StoredConfig> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as StoredConfig;
    } catch {
      return {};
    }
  }

  /** The runner and its settings. For Codex and agy, `model` "" means the CLI's own default. */
  async resolved(): Promise<{ runner: Runner; apiKey: string | undefined; model: string; effort: Effort }> {
    const cfg = (await this.read()).agent ?? {};
    const runner = RUNNERS.includes(cfg.runner as Runner) ? cfg.runner! : this.defaults.runner;
    // Without a stored key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    return {
      runner,
      apiKey: cfg.apiKey || undefined,
      model:
        runner === 'codex'
          ? cliModel(cfg.codexModel)
          : runner === 'agy'
            ? cliModel(cfg.agyModel)
            : AGENT_MODELS.some((m) => m.id === cfg.model)
              ? cfg.model!
              : this.defaults.model,
      effort: EFFORTS.includes(cfg.effort as Effort) ? cfg.effort! : this.defaults.effort,
    };
  }

  async info(): Promise<AgentConfigInfo> {
    const r = await this.resolved();
    const [keySource, claudeCode, codex, agy, models] = await Promise.all([
      this.keySource(r.apiKey),
      this.probes.claudeCode(),
      this.probes.codex(),
      this.probes.agy(),
      this.modelsFor(r.runner),
    ]);
    return { runner: r.runner, keySource, claudeCode, codex, agy, model: r.model, effort: r.effort, models };
  }

  private async modelsFor(runner: Runner): Promise<ModelList> {
    if (runner === 'codex') {
      const [list, configured] = await Promise.all([this.probes.codexModels(), this.probes.codexDefault()]);
      return [{ id: '', label: configured ? `Default (${configured})` : 'Default model' }, ...list];
    }
    if (runner === 'agy') {
      // `agy models` asks Google's servers, so the list is fetched once per server run.
      if (!this.agyModelCache.length) this.agyModelCache = await this.probes.agyModels();
      return [{ id: '', label: 'Default model' }, ...this.agyModelCache];
    }
    return AGENT_MODELS;
  }

  private async keySource(apiKey: string | undefined): Promise<AgentConfigInfo['keySource']> {
    if (apiKey) return 'settings';
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'environment';
    return (await hasSdkProfile()) ? 'profile' : null;
  }

  /** `model` applies to the runner this leaves selected (each runner remembers its own). */
  async update(patch: { runner?: Runner; apiKey?: string | null; model?: string; effort?: Effort }): Promise<void> {
    const cfg = await this.read();
    const agent = { ...(cfg.agent ?? {}) };
    if (patch.runner && RUNNERS.includes(patch.runner)) agent.runner = patch.runner;
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey?.trim();
      if (key) agent.apiKey = key;
      else delete agent.apiKey;
    }
    if (patch.model !== undefined) {
      const runner = RUNNERS.includes(agent.runner as Runner) ? agent.runner! : this.defaults.runner;
      if (runner === 'codex' || runner === 'agy') {
        const slot = runner === 'codex' ? 'codexModel' : 'agyModel';
        const model = cliModel(patch.model);
        if (model) agent[slot] = model;
        else delete agent[slot];
      } else if (AGENT_MODELS.some((m) => m.id === patch.model)) agent.model = patch.model;
    }
    if (patch.effort && EFFORTS.includes(patch.effort)) agent.effort = patch.effort;
    await writeFileAtomic(this.path, JSON.stringify({ ...cfg, agent }, null, 2), 0o600);
  }

  /** Let agy run OpenPaper's design tools: one allow rule in its settings, added when the user asks. */
  async allowAgy(): Promise<void> {
    await this.probes.allowAgy();
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
