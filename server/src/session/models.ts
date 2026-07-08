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
  // The first model kiro lists (`auto`) is its default.
  const parsed = JSON.parse(stdout) as { models: RawModel[] };
  cache = parsed.models.map((m, i) => ({
    modelId: m.model_id,
    modelName: m.model_name,
    description: m.description,
    contextWindowTokens: m.context_window_tokens,
    rateMultiplier: m.rate_multiplier,
    rateUnit: m.rate_unit,
    isDefault: m.default_model ?? i === 0,
  }));
  log.info({ count: cache.length }, 'loaded model list');
  return cache;
}

export async function kiroVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(config.kiroBin, ['--version']);
    return stdout.trim();
  } catch {
    return undefined;
  }
}
