import type {
  AgentsResponse,
  CreateSessionRequest,
  DevicesResponse,
  DirListing,
  HealthResponse,
  ModelsResponse,
  SessionDetail,
  SessionListResponse,
  TreeResponse,
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
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
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
  health: () => req<HealthResponse>('GET', '/api/health'),
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
  deleteSession: (id: string) => req<{ ok: boolean }>('DELETE', `/api/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    req<{ ok: boolean }>('POST', `/api/sessions/${id}/rename`, { title }),
  setModel: (id: string, modelId: string) =>
    req('POST', `/api/sessions/${id}/model`, { modelId }),
  setMode: (id: string, modeId: string) =>
    req('POST', `/api/sessions/${id}/mode`, { modeId }),
  /** List files/directories in a session's workspace. */
  tree: (id: string, relativePath = '') =>
    req<TreeResponse>(
      'GET',
      `/api/sessions/${id}/tree?path=${encodeURIComponent(relativePath)}`,
    ),
  /** Trigger a file download from a session's workspace. */
  downloadUrl: (id: string, relativePath: string) =>
    `/api/sessions/${id}/download?path=${encodeURIComponent(relativePath)}`,
};
