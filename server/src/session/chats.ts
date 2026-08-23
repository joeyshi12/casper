import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Everything a chat owns on disk lives under one directory named by its chat id:
 *
 *   <data dir>/chats/<chat id>/uploads     files the user attached
 *   <data dir>/chats/<chat id>/workspace   the agent's files, if Casper made the cwd
 *
 * The id is the chat's own, minted by the client before it sends anything, because kiro
 * does not name a session until it starts one and the user can attach a file before that.
 * Keying this directory on kiro's session id instead - which is what it used to do - meant
 * a brand-new chat had nowhere to put an upload.
 *
 * `workspace` is absent for a chat pointed at a directory the user chose, which is most of
 * them; only a chat given a workspace of its own has one here.
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
 * Where uploads used to go, still read for sessions that predate the chats layout. Recorded
 * attachment paths are absolute, so old files keep resolving without being moved.
 */
export function legacyUploadsDir(sessionId: string): string {
  return path.join(config.casperDataDir, 'sessions', sessionId, 'uploads');
}

function legacyWorkspacesRoot(): string {
  return path.join(config.casperDataDir, 'workspaces');
}

/**
 * Whether a working directory is one Casper made, rather than one the user picked - so the
 * session list can show a folder name for the latter and nothing for the former.
 *
 * Both layouts count: workspaces created before this change stay where they are, since
 * their path is recorded in casper.db and in kiro's own session file, and rewriting kiro's
 * state to relocate them would risk a session for no visible gain.
 */
export function isManagedWorkspace(dir: string): boolean {
  return [chatsRoot(), legacyWorkspacesRoot()].some(
    (root) => dir === root || dir.startsWith(root + path.sep),
  );
}
