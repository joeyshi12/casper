import type {
  AgentsResponse,
  CreateSessionRequest,
  HealthResponse,
  ModelsResponse,
  SessionDetail,
  SessionListResponse,
} from '@casper/shared';

const TOKEN_KEY = 'casper.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  // Only declare a JSON content-type when we actually send a body - Fastify
  // rejects a bodyless request (e.g. DELETE) that claims application/json.
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('Unauthorized - check your access token');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const api = {
  health: () => req<HealthResponse>('GET', '/api/health'),
  models: () => req<ModelsResponse>('GET', '/api/models'),
  agents: () => req<AgentsResponse>('GET', '/api/agents'),
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
};
