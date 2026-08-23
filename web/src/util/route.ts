/** Owns the chat URL shape: the route pattern and the paths that match it. */
const CHATS = '/chats';

export const CHAT_ROUTE = `${CHATS}/:chatId`;

export function pathForChat(id: string): string {
  return `${CHATS}/${encodeURIComponent(id)}`;
}

/** A chat the user is composing but the server has not been told about yet. */
export const DRAFT_PATH = `${CHATS}/new`;
