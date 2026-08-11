import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router';
import type { PromptContentBlock } from '@casper/shared';
import { stripAttachmentsLine } from '@casper/shared';
import { useStore } from './state/store.js';
import { api, logout } from './api/rest.js';
import { SessionSocket, type ConnStatus } from './api/SessionSocket.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ChatPane } from './components/layout/ChatPane.js';
import { NewSessionSheet } from './components/sessions/NewSessionSheet.js';
import { TokenGate } from './components/common/TokenGate.js';
import { SESSION_ROUTE, pathForSession } from './util/route.js';

type AuthState = 'checking' | 'gate' | 'ready';

// Human names for the control actions the server acks, so a rejection reads as
// "Model change failed: ..." rather than leaking the wire action name.
const ACTION_LABEL: Record<string, string> = {
  prompt: 'Message',
  cancel: 'Stop',
  set_mode: 'Agent change',
  set_model: 'Model change',
  exec_command: 'Command',
};

export function App() {
  // Probe first, so an already-authed user never sees the login page flash by.
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
  return (
    <BrowserRouter>
      <Routes>
        {/* A layout route, so navigating doesn't remount Shell and drop the
            socket. The children only exist to put :sessionId in the URL. */}
        <Route element={<Shell onLock={() => setAuth('gate')} />}>
          <Route index element={null} />
          <Route path="sessions/:sessionId" element={null} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/** Sidebar beside the chat on desktop, one pane at a time on mobile. */
function Shell({ onLock }: { onLock: () => void }) {
  const store = useStore();
  const navigate = useNavigate();
  // Not useParams: the param belongs to the child route, so it isn't visible here.
  const routeSessionId = useMatch(SESSION_ROUTE)?.params.sessionId ?? null;
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
    // Quiet on failure: an empty picker is its own signal, and refreshSessions()
    // below has always failed quietly too.
    api
      .models()
      .then((r) => store.setModels(r.models))
      .catch(() => {});
    api
      .agents()
      .then((r) => store.setAgents(r.agents, r.defaultAgentId))
      .catch(() => {});
    refreshSessions();
  }, []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  // The cookie is already invalid, so drop the session and show the gate rather
  // than looping on reconnects.
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
      useStore.getState().setLoadingSession(id);

      let detail: Awaited<ReturnType<typeof api.getSession>>;
      try {
        detail = await api.getSession(id);
      } catch (err) {
        // Fetch failed (network, or the session was deleted): don't strand the
        // UI in "connecting" - reset and surface the error.
        setConnStatus('closed');
        useStore.getState().setLoadingSession(null);
        console.error('open session failed:', err);
        // Replaced, so a refresh doesn't retry it and back doesn't return to it.
        navigate('/', { replace: true });
        return;
      }
      store.loadDetail(detail);

      const socket = new SessionSocket(
        id,
        {
          onEvent: (e) => {
            useStore.getState().applyEvent(e);
            // kiro persists the session around now, so reconcile the list for its
            // real updatedAt, title and credits. Delayed until that settles.
            if (e.payload.kind === 'turn_ended') {
              setTimeout(refreshSessions, 1200);
            }
          },
          onStatus: setConnStatus,
          onResync: async () => {
            const fresh = await api.getSession(id);
            useStore.getState().loadDetail(fresh);
            socketRef.current?.reset(fresh.head);
          },
          onAck: (action, ok, error) => {
            if (ok) return;
            // The server explains every rejection (dispatch.ts sends the thrown
            // message); don't drop it on the floor.
            const reason = error ?? 'The server rejected the request.';
            if (action === 'prompt') {
              // The reason rides on the failed bubble, which is where the user
              // is already looking.
              if (lastSentRef.current) {
                useStore.getState().markPendingFailed(lastSentRef.current, reason);
              }
              return;
            }
            // set_model / set_mode / cancel / exec_command have no bubble to
            // attach to, so this only reaches the console for now.
            console.error(`${ACTION_LABEL[action] ?? action} rejected:`, reason);
          },
          onUnauthorized: handleUnauthorized,
          onServerError: (message) => {
            console.error('server error:', message);
          },
        },
        detail.head,
      );
      socketRef.current = socket;
      socket.connect();
    },
    [closeSocket, handleUnauthorized, navigate, refreshSessions, store],
  );

  const backToList = useCallback(() => navigate('/'), [navigate]);

  // Marked before the route changes, or the pane flashes back to the list.
  // Not for the open session: the route wouldn't change, so nothing clears it.
  const markLoading = useCallback((id: string) => {
    if (id === useStore.getState().activeId) return;
    useStore.getState().setLoadingSession(id);
  }, []);

  const goToSession = useCallback(
    (id: string) => {
      markLoading(id);
      navigate(pathForSession(id));
    },
    [markLoading, navigate],
  );

  // The route owns which session is open, so cold loads, back/forward and
  // clicks all arrive here. The ref fires it on URL changes, not renders.
  const handledRoute = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (handledRoute.current === routeSessionId) return;
    handledRoute.current = routeSessionId;
    if (routeSessionId) {
      void openSession(routeSessionId);
    } else {
      closeSocket();
      store.clearActive();
      refreshSessions();
    }
  }, [routeSessionId, openSession, closeSocket, refreshSessions, store]);

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
        goToSession(detail.summary.sessionId);
      } catch (err) {
        // Keep the user on the chat pane and show what went wrong; `creating`
        // stays true so `hasActive` holds the view open for the error screen.
        setConnStatus('closed');
        setCreateError(err instanceof Error ? err.message : 'Failed to create session');
      } finally {
        setCreating(false);
      }
    },
    [closeSocket, goToSession, refreshSessions],
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
      try {
        await api.deleteSession(id);
      } catch {
        console.error('delete session failed');
        refreshSessions();
        return;
      }
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
      await api.renameSession(id, title).catch(() => {
        console.error('rename session failed');
      });
      refreshSessions();
    },
    [refreshSessions],
  );

  // Send a prompt. The user bubble shows immediately as "sending"; the server's
  // turn_started echo clears it, and a delivery failure flags it for retry.
  const sendMessage = useCallback(
    (id: string, content: PromptContentBlock[]) => {
      lastSentRef.current = id;
      const delivered = socketRef.current?.prompt(content) ?? false;
      if (!delivered) {
        // The socket wasn't open, so the server never saw this. Say so on the
        // bubble itself rather than leaving it unexplained.
        const reason = socketRef.current
          ? 'Not connected to the server - reconnecting. Retry once the status dot is green.'
          : 'No active session socket.';
        useStore.getState().markPendingFailed(id, reason);
      }
    },
    [],
  );

  const send = useCallback(
    (content: PromptContentBlock[]) => {
      const id = `pending-${msgSeqRef.current++}`;
      // Extract text for the pending bubble, minus the machine-facing
      // "Attached files:" line (the transcript renders thumbnails instead).
      const text = stripAttachmentsLine(
        content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
      );
      const hasImages = content.some((b) => b.type === 'image');
      const displayText = text || (hasImages ? '[image]' : '[attachment]');
      useStore.getState().addPending(id, displayText);
      sendMessage(id, content);
    },
    [sendMessage],
  );

  const retrySend = useCallback(
    (id: string, text: string) => {
      useStore.setState((prev) => ({
        pending: prev.pending.map((p) =>
          p.id === id ? { ...p, status: 'sending' as const, error: undefined } : p,
        ),
      }));
      sendMessage(id, [{ type: 'text', text }]);
    },
    [sendMessage],
  );

  // Retry a turn that failed: send the same prompt again as a fresh message, so
  // it gets its own pending bubble and its own failure reason if it fails twice.
  const retryTurn = useCallback(
    (text: string) => {
      send([{ type: 'text', text }]);
    },
    [send],
  );

  const cancel = useCallback(() => {
    socketRef.current?.cancel();
    // Optimistic feedback: the Stop button flips to "Stopping…" until the
    // server confirms with turn_ended / turn_error (which reset to idle).
    useStore.setState((s) =>
      s.observability.turnStatus === 'running'
        ? { observability: { ...s.observability, turnStatus: 'cancelling' } }
        : {},
    );
  }, []);
  const changeModel = useCallback((modelId: string) => {
    socketRef.current?.setModel(modelId);
    useStore.setState({ currentModelId: modelId });
  }, []);
  const changeAgent = useCallback((modeId: string) => {
    socketRef.current?.setMode(modeId);
    // Optimistic in both the picker (currentModeId) and the sidebar row (agentId),
    // so neither waits for the next listSessions.
    useStore.setState((s) => ({
      currentModeId: modeId,
      sessions: s.activeId
        ? s.sessions.map((sess) =>
            sess.sessionId === s.activeId ? { ...sess, agentId: modeId } : sess,
          )
        : s.sessions,
    }));
  }, []);
  const compact = useCallback(() => {
    socketRef.current?.execCommand('compact');
    // Optimistic: flip to compacting until the server's compaction/status
    // 'started' (which confirms) and 'completed' (which clears) arrive.
    useStore.setState((s) => ({ observability: { ...s.observability, compacting: true } }));
    // Safety net: if the command never lands (e.g. the socket dropped) and no
    // compaction/status ever arrives, don't leave the UI stuck compacting.
    setTimeout(() => {
      useStore.setState((s) =>
        s.observability.compacting
          ? { observability: { ...s.observability, compacting: false } }
          : {},
      );
    }, 120_000);
  }, []);

  // Lock the app: clear the session cookie server-side, tear down the socket,
  // and clear the active session so nothing lingers behind the login gate.
  const lock = useCallback(() => {
    void logout();
    closeSocket();
    store.clearActive();
    navigate('/', { replace: true });
    onLock();
  }, [closeSocket, onLock, store]);

  const hasActive =
    store.activeId !== null ||
    store.loadingSessionId !== null ||
    creating ||
    createError !== null;

  return (
    <div className={`layout ${hasActive ? 'has-active' : ''}`}>
      <Sidebar
        sessions={store.sessions}
        activeId={store.activeId}
        loadingId={store.loadingSessionId}
        onOpen={markLoading}
        onNew={() => setNewOpen(true)}
        onDelete={deleteSession}
        onRename={renameSession}
        onLock={lock}
      />
      <ChatPane
        hasActive={hasActive}
        loadingSessionId={store.loadingSessionId}
        connStatus={connStatus}
        creating={creating}
        createError={createError}
        onRetryCreate={retryCreate}
        onDismissError={dismissCreateError}
        onBack={backToList}
        onSend={send}
        onRetry={retrySend}
        onRetryTurn={retryTurn}
        onCancel={cancel}
        onNew={() => setNewOpen(true)}
        onChangeModel={changeModel}
        onChangeAgent={changeAgent}
        onCompact={compact}
      />
      {newOpen && (
        <NewSessionSheet onCreate={createSession} onClose={() => setNewOpen(false)} />
      )}
    </div>
  );
}
