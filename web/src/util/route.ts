/** Owns the chat URL shape: the route pattern and the paths that match it. */
const CHATS = '/chats';

export const CHAT_ROUTE = `${CHATS}/:chatId`;

export function pathForChat(id: string): string {
  return `${CHATS}/${encodeURIComponent(id)}`;
}

/**
 * A chat the user is composing but the server has not been told about yet. Its own path rather
 * than a chat id, so nothing has to reserve the name "new" among real ones.
 */
export const DRAFT_PATH = '/new';
