import type {
  AgentsResponse,
  CreateChatRequest,
  DevicesResponse,
  DirListing,
  ModelsResponse,
  ChatDetail,
  ChatListResponse,
  SubagentDetailResponse,
  SubagentListResponse,
  TranscriptPageResponse,
  TreeResponse,
  UploadResponse,
} from '@casper/shared';

// Auth is a server-set httpOnly session cookie, established via POST /api/login
// with the shared secret. The browser attaches it automatically on same-origin
// requests (including the WS upgrade), so nothing sensitive lives in JS.

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  // Only declare a JSON content-type when we actually send a body - Fastify
  // rejects a bodyless request (e.g. DELETE) that claims application/json.
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('Unauthorized');
  if (!res.ok) {
    const text = await res.text();
    // The server explains every rejection in { error }. Prefer that sentence: the
    // raw body puts JSON and a status code in front of the user.
    let reason = '';
    try {
      reason = (JSON.parse(text) as { error?: string }).error ?? '';
    } catch {
      /* not JSON */
    }
    throw new Error(reason || `${method} ${path} failed (${res.status}): ${text}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export function login(token: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>('POST', '/api/login', { token });
}

export function logout(): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>('POST', '/api/logout');
}

export const api = {
  devices: () => req<DevicesResponse>('GET', '/api/devices'),
  revokeDevice: (id: string) => req<{ ok: boolean }>('DELETE', `/api/devices/${id}`),
  logoutAll: () => req<{ ok: boolean }>('POST', '/api/logout-all'),
  models: () => req<ModelsResponse>('GET', '/api/models'),
  agents: () => req<AgentsResponse>('GET', '/api/agents'),
  listDirs: (path: string) =>
    req<DirListing>('GET', `/api/fs/dirs?path=${encodeURIComponent(path)}`),
  listChats: () => req<ChatListResponse>('GET', '/api/chats'),
  createChat: (body: CreateChatRequest) =>
    req<ChatDetail>('POST', '/api/chats', body),
  getChat: (id: string) => req<ChatDetail>('GET', `/api/chats/${id}`),
  transcriptPage: (id: string, offset: number, limit: number) =>
    req<TranscriptPageResponse>(
      'GET',
      `/api/chats/${id}/transcript?offset=${offset}&limit=${limit}`,
    ),
  subagents: (id: string) => req<SubagentListResponse>('GET', `/api/chats/${id}/subagents`),
  subagentDetail: (id: string, subagentId: string) =>
    req<SubagentDetailResponse>('GET', `/api/chats/${id}/subagents/${subagentId}`),
  deleteChat: (id: string) => req<{ ok: boolean }>('DELETE', `/api/chats/${id}`),
  renameChat: (id: string, title: string) =>
    req<{ ok: boolean }>('POST', `/api/chats/${id}/rename`, { title }),
  setChatCwd: (id: string, cwd: string) =>
    req<{ ok: boolean; cwd: string }>('POST', `/api/chats/${id}/cwd`, { cwd }),
  reloadChat: (id: string) =>
    req<ChatDetail>('POST', `/api/chats/${id}/reload`),
  tree: (id: string, relativePath = '') =>
    req<TreeResponse>(
      'GET',
      `/api/chats/${id}/tree?path=${encodeURIComponent(relativePath)}`,
    ),
  downloadUrl: (id: string, filePath: string) =>
    filePath.startsWith('/')
      ? `/api/fs/file?download=1&path=${encodeURIComponent(filePath)}`
      : `/api/chats/${id}/download?path=${encodeURIComponent(filePath)}`,
  /** An absolute path goes to the filesystem route: uploads live under the data
   *  directory, outside any session's cwd, so the workspace route cannot reach them. */
  previewUrl: (id: string, filePath: string) =>
    filePath.startsWith('/')
      ? `/api/fs/file?path=${encodeURIComponent(filePath)}`
      : `/api/chats/${id}/preview?path=${encodeURIComponent(filePath)}`,
  /** Keyed by chat, not session id: a draft uploads before it has a session. */
  uploadFiles: async (chatId: string, files: File[]): Promise<UploadResponse> => {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/uploads`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    if (res.status === 401) throw new Error('Unauthorized');
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}): ${text}`);
    }
    return (await res.json()) as UploadResponse;
  },
};
