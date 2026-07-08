import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { Logger } from '../util/logger.js';

/**
 * Casper-side title overrides. kiro owns the session `.json` files (and derives
 * a title from the first prompt), so user renames are stored separately here in
 * ~/.casper/titles.json and overlaid onto session summaries.
 */
export class TitleStore {
  private map: Record<string, string> = {};
  private readonly file: string;
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
    this.file = path.join(config.casperDataDir, 'titles.json');
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
      this.log.warn({ err }, 'titles: could not persist rename');
    }
  }

  get(sessionId: string): string | undefined {
    return this.map[sessionId];
  }

  set(sessionId: string, title: string): void {
    const trimmed = title.trim();
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
