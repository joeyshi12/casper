import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read/write access to the settings file for the subcommands that edit it.
 *
 * The server reads settings once at startup through config.ts; these helpers exist
 * because `casper token` and `casper reset-token` need the file itself, and must
 * not disturb keys they don't understand.
 */
export function readSettings(file: string): Record<string, unknown> {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return {};
    return doc as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Merge changes into the settings file, preserving everything else.
 *
 * Written to a same-directory temp and renamed so a crash can't leave a truncated
 * config, and 0600 because the file holds the access token.
 */
export function updateSettings(file: string, changes: Record<string, unknown>): void {
  const merged = { ...readSettings(file), ...changes };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 24 random bytes as hex - the same strength the shell installer used. */
export function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Print a token in a bordered block so it survives a wall of install output. */
export function printTokenBlock(token: string, heading: string): void {
  const line = '─'.repeat(Math.max(heading.length, token.length) + 2);
  process.stdout.write(
    `\n┌${line}┐\n` +
      `│ ${heading.padEnd(line.length - 2)} │\n` +
      `│ ${''.padEnd(line.length - 2)} │\n` +
      `│ ${token.padEnd(line.length - 2)} │\n` +
      `└${line}┘\n\n`,
  );
}
