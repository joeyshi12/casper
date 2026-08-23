import type {
  AgentsResponse,
  CreateSessionRequest,
  DevicesResponse,
  DirListing,
  ModelsResponse,
  SessionDetail,
  SessionListResponse,
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

/** Log in with the shared secret. On success the server sets the session cookie. */
export function login(token: string): Promise<{ ok: boolean }> {
  return req<{ ok: boolean }>('POST', '/api/login', { token });
}

/** Log out this device: revokes its session server-side and clears the cookie. */
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
  listSessions: () => req<SessionListResponse>('GET', '/api/sessions'),
  createSession: (body: CreateSessionRequest) =>
    req<SessionDetail>('POST', '/api/sessions', body),
  getSession: (id: string) => req<SessionDetail>('GET', `/api/sessions/${id}`),
  /** Fetch an older page of transcript items: [offset, offset+limit). */
  transcriptPage: (id: string, offset: number, limit: number) =>
    req<TranscriptPageResponse>(
      'GET',
      `/api/sessions/${id}/transcript?offset=${offset}&limit=${limit}`,
    ),
  deleteSession: (id: string) => req<{ ok: boolean }>('DELETE', `/api/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    req<{ ok: boolean }>('POST', `/api/sessions/${id}/rename`, { title }),
  /** Re-point a session at a different working directory. */
  setSessionCwd: (id: string, cwd: string) =>
    req<{ ok: boolean; cwd: string }>('POST', `/api/sessions/${id}/cwd`, { cwd }),
  /**
   * Restart the session's kiro process so its `.kiro` directory, agent definition
   * and MCP servers are detected again. Answers with the refreshed detail.
   */
  reloadSession: (id: string) =>
    req<SessionDetail>('POST', `/api/sessions/${id}/reload`),
  /** List files/directories in a session's workspace. */
  tree: (id: string, relativePath = '') =>
    req<TreeResponse>(
      'GET',
      `/api/sessions/${id}/tree?path=${encodeURIComponent(relativePath)}`,
    ),
  /** Trigger a file download from a session's workspace. */
  downloadUrl: (id: string, filePath: string) =>
    filePath.startsWith('/')
      ? `/api/fs/file?download=1&path=${encodeURIComponent(filePath)}`
      : `/api/sessions/${id}/download?path=${encodeURIComponent(filePath)}`,
  /**
   * Preview URL for a file. An absolute path goes to the filesystem route: uploads live
   * under the data directory, outside any session's cwd, so the workspace route cannot
   * reach them.
   */
  previewUrl: (id: string, filePath: string) =>
    filePath.startsWith('/')
      ? `/api/fs/file?path=${encodeURIComponent(filePath)}`
      : `/api/sessions/${id}/preview?path=${encodeURIComponent(filePath)}`,
  /** Upload files for a session (stored under the data directory). */
  /** Keyed by chat, not session: a draft uploads before it has one. */
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
