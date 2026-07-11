import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptContentBlock } from '@casper/shared';
import { useStore } from './state/store.js';
import { api, logout } from './api/rest.js';
import { SessionSocket, type ConnStatus } from './api/SessionSocket.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ChatPane } from './components/layout/ChatPane.js';
import { NewSessionSheet } from './components/sessions/NewSessionSheet.js';
import { TokenGate } from './components/common/TokenGate.js';

type AuthState = 'checking' | 'gate' | 'ready';

export function App() {
  // Start in 'checking' and probe the server: if a valid session cookie is
  // present the request succeeds and we skip the login page; a 401 falls back
  // to the gate. This avoids flashing the login page for an already-authed user.
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    if (auth !== 'checking') return;
    api
      .listSessions()
      .then(() => setAuth('ready'))
      .catch(() => setAuth('gate'));
  }, [auth]);

  if (auth === 'checking') return <div className="app-splash" />;
  if (auth === 'gate') return <TokenGate onReady={() => setAuth('ready')} />;
  return <Shell onLock={() => setAuth('gate')} />;
}

/**
 * Responsive shell, modeled on Happy's web layout: a persistent session sidebar
 * beside the chat on desktop, collapsing to a one-screen-at-a-time flow on
 * mobile. `has-active` drives which pane is visible on narrow screens.
 */
function Shell({ onLock }: { onLock: () => void }) {
  const store = useStore();
  const [newOpen, setNewOpen] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>('closed');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const lastCreateOpts = useRef<{ cwd: string; agentId: string; modelId: string } | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const msgSeqRef = useRef(0);

  const refreshSessions = useCallback(() => {
    api.listSessions().then((r) => store.setSessions(r.sessions)).catch(() => {});
  }, [store]);

  useEffect(() => {
    api.models().then((r) => store.setModels(r.models)).catch(() => {});
    api.agents().then((r) => store.setAgents(r.agents)).catch(() => {});
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  // The socket was rejected as unauthorized (session expired or missing). The
  // cookie is already invalid, so just drop the active session and return to
  // the login gate rather than looping on reconnects.
  const handleUnauthorized = useCallback(() => {
    closeSocket();
    store.clearActive();
    onLock();
  }, [closeSocket, onLock, store]);

  const openSession = useCallback(
    async (id: string) => {
      if (store.activeId === id) return;
      closeSocket();
      setConnStatus('connecting');

      const detail = await api.getSession(id);
      store.loadDetail(detail);

      const socket = new SessionSocket(
        id,
        {
          onEvent: (e) => useStore.getState().applyEvent(e),
          onStatus: setConnStatus,
          onResync: async () => {
            const fresh = await api.getSession(id);
            useStore.getState().loadDetail(fresh);
            socketRef.current?.reset(fresh.head);
          },
          onAck: (action, ok) => {
            // A rejected prompt (e.g. a turn already running) fails its bubble.
            if (action === 'prompt' && !ok && lastSentRef.current) {
              useStore.getState().markPendingFailed(lastSentRef.current);
            }
          },
          onUnauthorized: handleUnauthorized,
        },
        detail.head,
      );
      socketRef.current = socket;
      socket.connect();
    },
    [closeSocket, handleUnauthorized, store],
  );

  const backToList = useCallback(() => {
    closeSocket();
    store.clearActive();
    refreshSessions();
  }, [closeSocket, refreshSessions, store]);

  const createSession = useCallback(
    async (opts: { cwd: string; agentId: string; modelId: string }) => {
      setNewOpen(false);
      // Enter the session view right away; it shows "Connecting" until ready.
      closeSocket();
      setConnStatus('connecting');
      setCreateError(null);
      setCreating(true);
      lastCreateOpts.current = opts;
      try {
        const detail = await api.createSession({
          cwd: opts.cwd || undefined,
          agentId: opts.agentId,
          modelId: opts.modelId,
        });
        refreshSessions();
        await openSession(detail.summary.sessionId);
      } catch (err) {
        // Keep the user on the chat pane and show what went wrong; `creating`
        // stays true so `hasActive` holds the view open for the error screen.
        setConnStatus('closed');
        setCreateError(err instanceof Error ? err.message : 'Failed to create session');
      } finally {
        setCreating(false);
      }
    },
    [closeSocket, openSession, refreshSessions],
  );

  const retryCreate = useCallback(() => {
    if (lastCreateOpts.current) void createSession(lastCreateOpts.current);
  }, [createSession]);

  const dismissCreateError = useCallback(() => {
    setCreateError(null);
    backToList();
  }, [backToList]);

  const deleteSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id).catch(() => {});
      if (store.activeId === id) backToList();
      else refreshSessions();
    },
    [backToList, refreshSessions, store],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      // Optimistic: update the list immediately, then persist.
      useStore.setState((prev) => ({
        sessions: prev.sessions.map((s) =>
          s.sessionId === id ? { ...s, title } : s,
        ),
      }));
      await api.renameSession(id, title).catch(() => {});
      refreshSessions();
    },
    [refreshSessions],
  );

  // Send a prompt. The user bubble shows immediately as "sending"; the server's
  // turn_started echo clears it, and a delivery failure flags it for retry.
  const sendMessage = useCallback((id: string, content: PromptContentBlock[]) => {
    lastSentRef.current = id;
    const delivered = socketRef.current?.prompt(content) ?? false;
    if (!delivered) useStore.getState().markPendingFailed(id);
  }, []);

  const send = useCallback(
    (content: PromptContentBlock[]) => {
      const id = `pending-${msgSeqRef.current++}`;
      // Extract text for the pending message display.
      const text = content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const hasImages = content.some((b) => b.type === 'image');
      const displayText = hasImages && !text ? '[image]' : text || '[attachment]';
      useStore.getState().addPending(id, displayText);
      sendMessage(id, content);
    },
    [sendMessage],
  );

  const retrySend = useCallback(
    (id: string, text: string) => {
      useStore.setState((prev) => ({
        pending: prev.pending.map((p) =>
          p.id === id ? { ...p, status: 'sending' as const } : p,
        ),
      }));
      sendMessage(id, [{ type: 'text', text }]);
    },
    [sendMessage],
  );

  const cancel = useCallback(() => socketRef.current?.cancel(), []);
  const changeModel = useCallback((modelId: string) => {
    socketRef.current?.setModel(modelId);
    useStore.setState({ currentModelId: modelId });
  }, []);
  const changeAgent = useCallback((modeId: string) => {
    socketRef.current?.setMode(modeId);
    useStore.setState({ currentModeId: modeId });
  }, []);

  // Lock the app: clear the session cookie server-side, tear down the socket,
  // and clear the active session so nothing lingers behind the login gate.
  const lock = useCallback(() => {
    void logout();
    closeSocket();
    store.clearActive();
    onLock();
  }, [closeSocket, onLock, store]);

  const hasActive = store.activeId !== null || creating || createError !== null;

  return (
    <div className={`layout ${hasActive ? 'has-active' : ''}`}>
      <Sidebar
        sessions={store.sessions}
        activeId={store.activeId}
        onOpen={openSession}
        onNew={() => setNewOpen(true)}
        onDelete={deleteSession}
        onRename={renameSession}
        onLock={lock}
      />
      <ChatPane
        hasActive={hasActive}
        connStatus={connStatus}
        creating={creating}
        createError={createError}
        onRetryCreate={retryCreate}
        onDismissError={dismissCreateError}
        onBack={backToList}
        onSend={send}
        onRetry={retrySend}
        onCancel={cancel}
        onNew={() => setNewOpen(true)}
        onChangeModel={changeModel}
        onChangeAgent={changeAgent}
      />
      {newOpen && (
        <NewSessionSheet onCreate={createSession} onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}
