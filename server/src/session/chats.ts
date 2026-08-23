import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Everything a chat owns on disk, under one directory named by its chat id:
 *
 *   <data dir>/chats/<chat id>/uploads     files the user attached
 *   <data dir>/chats/<chat id>/workspace   the agent's files, if Casper made the cwd
 *
 * The client mints the id, because kiro does not name a session until it starts one and a file
 * can be attached before that. `workspace` exists only for a chat Casper made a cwd for.
 */
export function chatsRoot(): string {
  return path.join(config.casperDataDir, 'chats');
}

export function chatDir(chatId: string): string {
  return path.join(chatsRoot(), chatId);
}

export function chatUploadsDir(chatId: string): string {
  return path.join(chatDir(chatId), 'uploads');
}

export function chatWorkspaceDir(chatId: string): string {
  return path.join(chatDir(chatId), 'workspace');
}

/** A new, empty workspace for a chat. 0700 because it holds whatever the agent writes. */
export function createChatWorkspace(chatId: string): string {
  const dir = chatWorkspaceDir(chatId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Whether a working directory is one Casper made, rather than one the user picked - so the
 * session list can show a folder name for the latter and nothing for the former.
 */
export function isManagedWorkspace(dir: string): boolean {
  const root = chatsRoot();
  return dir === root || dir.startsWith(root + path.sep);
}
