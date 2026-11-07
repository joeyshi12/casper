import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ModelInfo } from '@casper/shared';
import { config } from '../config.js';

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
 * Fetch the available model list via `kiro-cli chat --list-models -f json`.
 * Cached for the process lifetime (the list is essentially static).
 */
export async function listModels(log: MiniLogger): Promise<ModelInfo[]> {
  if (cache) return cache;
  const { stdout } = await execFileAsync(
    config.kiroBin,
    ['chat', '--list-models', '-f', 'json'],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { models: RawModel[]; default_model?: string };
  const configured = await configuredDefault();
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
  return cache;
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

export async function kiroVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(config.kiroBin, ['--version']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}
