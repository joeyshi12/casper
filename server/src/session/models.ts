import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ModelInfo } from '@casper/shared';
import { config } from '../config.js';
import { kiroModels } from './kiroModels.js';

/** Minimal logger shape - satisfied by both pino and Fastify's logger. */
interface MiniLogger {
  info(obj: object, msg?: string): void;
}

const execFileAsync = promisify(execFile);

interface RawModel {
  model_id: string;
  model_name: string;
  description: string;
  context_window_tokens: number;
  rate_multiplier: number;
  rate_unit: string;
  default_model?: boolean;
}

let cache: ModelInfo[] | null = null;
let userEfforts: Map<string, string> = new Map();

/**
 * The model the user set as kiro's default, from `settings chat.defaultModel`. It
 * differs from the list's own default_model ('auto'), and Casper gives it to new chats
 * (see defaultModelId).
 */
async function configuredDefault(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(config.kiroBin, [
      'settings',
      'chat.defaultModel',
      '-f',
      'json',
    ]);
    const value = JSON.parse(stdout) as unknown;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined; // unset, or a kiro without the key
  }
}

/**
 * The effort the user set for each model in kiro's `chat.modelDefaults`, which looks like
 * `{"claude-opus-5.5": {"output_config": {"effort": "xhigh"}}}`. kiro V3 does not apply it
 * to an ACP session itself, so Casper passes it to a new chat.
 */
async function configuredEfforts(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { stdout } = await execFileAsync(config.kiroBin, ['settings', 'chat.modelDefaults', '-f', 'json']);
    const value = JSON.parse(stdout) as unknown;
    if (!value || typeof value !== 'object') return out;
    for (const [modelId, settings] of Object.entries(value as Record<string, unknown>)) {
      if (!settings || typeof settings !== 'object') continue;
      // The key the effort sits under differs by model, so any section's `effort` counts.
      for (const section of Object.values(settings as Record<string, unknown>)) {
        const effort = (section as { effort?: unknown } | null)?.effort;
        if (typeof effort === 'string' && effort) {
          out.set(modelId, effort);
          break;
        }
      }
    }
  } catch {
    /* unset, or a kiro without the key */
  }
  return out;
}

/** A model with the name and effort levels kiro last reported for it. The list itself
 *  names each model by its id. */
function withKiroDetails(m: ModelInfo, known: ReturnType<typeof kiroModels>): ModelInfo {
  const k = known.get(m.modelId);
  if (!k) return m;
  const named = k.name ? { ...m, modelName: k.name } : m;
  if (k.levels.length === 0) return named;
  const own = userEfforts.get(m.modelId);
  const fallback = k.recommended && k.levels.includes(k.recommended) ? k.recommended : undefined;
  return {
    ...named,
    effortLevels: k.levels,
    recommendedEffort: fallback,
    defaultEffort: own && k.levels.includes(own) ? own : fallback,
  };
}

/**
 * Fetch the available model list via `kiro-cli chat --list-models -f json`.
 * Cached for the process lifetime (the list is essentially static).
 */
export async function listModels(log: MiniLogger): Promise<ModelInfo[]> {
  if (!cache) await loadModels(log);
  // Names and effort levels are added on each call: they are stored once a session reports them.
  const known = kiroModels();
  return cache!.map((m) => withKiroDetails(m, known));
}

async function loadModels(log: MiniLogger): Promise<void> {
  const { stdout } = await execFileAsync(
    config.kiroBin,
    ['chat', '--list-models', '-f', 'json'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { models: RawModel[]; default_model?: string };
  const [configured, efforts] = await Promise.all([configuredDefault(), configuredEfforts()]);
  userEfforts = efforts;
  // Only honour the setting if the model is actually listed, so an unknown id can't
  // leave the picker with nothing marked.
  const preferred = parsed.models.some((m) => m.model_id === configured)
    ? configured
    : parsed.default_model;
  cache = parsed.models.map((m, i) => ({
    modelId: m.model_id,
    modelName: m.model_name,
    description: m.description,
    contextWindowTokens: m.context_window_tokens,
    rateMultiplier: m.rate_multiplier,
    rateUnit: m.rate_unit,
    isDefault: preferred ? m.model_id === preferred : (m.default_model ?? i === 0),
  }));
  log.info({ count: cache.length, default: preferred }, 'loaded model list');
}

/**
 * The model a new chat gets when none was picked: the one the picker marks as default.
 * kiro V3 does not apply `chat.defaultModel` to an ACP session itself, so Casper passes
 * it, or every such chat would run on 'auto'.
 */
export async function defaultModelId(log: MiniLogger): Promise<string | undefined> {
  try {
    return (await listModels(log)).find((m) => m.isDefault)?.modelId;
  } catch {
    return undefined; // kiro is unavailable; the session gets kiro's own default
  }
}

/** The effort a new chat on the model gets, if the model has effort levels. */
export async function defaultEffortFor(modelId: string | undefined, log: MiniLogger): Promise<string | undefined> {
  if (!modelId) return undefined;
  try {
    return (await listModels(log)).find((m) => m.modelId === modelId)?.defaultEffort;
  } catch {
    return undefined;
  }
}

export async function kiroVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(config.kiroBin, ['--version']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}
