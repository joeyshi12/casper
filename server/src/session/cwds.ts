import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';

/**
 * Casper-side working-directory overrides. kiro owns the session `.json` files
 * (including the `cwd` a session was created with), so re-pointing a session at
 * a different folder - after the original was moved or deleted - is stored
 * separately here in ~/.casper/cwds.json and overlaid when the session opens.
 */
export class CwdStore {
  private map: Record<string, string> = {};
  private readonly file: string;
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
    this.file = path.join(config.casperDataDir, 'cwds.json');
    this.load();
  }

  private load(): void {
    try {
      this.map = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      this.map = {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(config.casperDataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
    } catch (err) {
      this.log.warn({ err }, 'cwds: could not persist override');
    }
  }

  get(sessionId: string): string | undefined {
    return this.map[sessionId];
  }

  set(sessionId: string, cwd: string): void {
    const trimmed = cwd.trim();
    if (trimmed) this.map[sessionId] = trimmed;
    else delete this.map[sessionId];
    this.persist();
  }

  remove(sessionId: string): void {
    if (this.map[sessionId] !== undefined) {
      delete this.map[sessionId];
      this.persist();
    }
  }
}
