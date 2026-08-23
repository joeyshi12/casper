import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { isValidChatId } from '../util/paths.js';

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
 * Everything a chat owns on disk, gone: uploads, and the workspace if Casper made one. A chat
 * that never got a directory is not an error. The id is validated first because it comes from
 * the client and this deletes a tree - an id that could traverse would take the wrong one.
 */
export async function removeChatDir(chatId: string): Promise<void> {
  if (!isValidChatId(chatId)) return;
  await fsp.rm(chatDir(chatId), { recursive: true, force: true });
}

/**
 * Whether a working directory is one Casper made, rather than one the user picked - so the
 * session list can show a folder name for the latter and nothing for the former.
 */
export function isManagedWorkspace(dir: string): boolean {
  const root = chatsRoot();
  return dir === root || dir.startsWith(root + path.sep);
}
