import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router';
import type { PromptContentBlock } from '@casper/shared';
import { stripAttachmentsLine, titleFromPrompt } from '@casper/shared';
import type { CreateSessionRequest } from '@casper/shared';
import { useStore } from './state/store.js';
import { api, logout } from './api/rest.js';
import { SessionSocket, type ConnStatus } from './api/SessionSocket.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ChatPane } from './components/layout/ChatPane.js';
import { TokenGate } from './components/common/TokenGate.js';
import { DRAFT_PATH, SESSION_ROUTE, pathForSession } from './util/route.js';
import { setPromptSender } from './state/promptBridge.js';

type AuthState = 'checking' | 'gate' | 'ready';

// Human names for the control actions the server acks, so a rejection reads as
// "Model change failed: ..." rather than leaking the wire action name.
type CreateOpts = Omit<CreateSessionRequest, 'freshWorkspace'>;

/** How long clustered list refreshes wait, so a burst becomes a single request. */
const LIST_COALESCE_MS = 150;

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
      .then((r) => {
        // This probe is also the first list fetch, so keep what it returned.
        useStore.getState().setSessions(r.sessions);
        setAuth('ready');
      })
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
  const matchedId = useMatch(SESSION_ROUTE)?.params.sessionId ?? null;
  // A draft is a session that does not exist yet: the chat opens immediately and the first
  // prompt creates it. Both the explicit /sessions/new route and the default page, so
  // landing with nothing open puts you in front of a composer.
  const isDraftRoute = matchedId === 'new';
  const isDraft = isDraftRoute || (!matchedId && store.activeId === null);
  const routeSessionId = isDraft ? null : matchedId;
  const [connStatus, setConnStatus] = useState<ConnStatus>('closed');
  // A draft's first prompt, held until the new session's socket is connected.
  const firstPromptRef = useRef<{ id: string; content: PromptContentBlock[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // What the last create was asked for, so the error screen's Retry can repeat it.
  const lastCreateOpts = useRef<CreateOpts | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const lastSentRef = useRef<string | null>(null);
  const msgSeqRef = useRef(0);

  // Refreshes cluster - boot, route changes, a turn starting or ending, a reconnect replaying
  // events - so calls within a short window collapse into one request, and only the newest
  // reply is applied: a late answer from before a session was named would undo its title.
  const listSeq = useRef(0);
  const listTimer = useRef<number | null>(null);
  const refreshSessions = useCallback(() => {
    if (listTimer.current !== null) return;
    listTimer.current = window.setTimeout(() => {
      listTimer.current = null;
      const seq = ++listSeq.current;
      api
        .listSessions()
        .then((r) => {
          if (seq === listSeq.current) useStore.getState().setSessions(r.sessions);
        })
        .catch(() => {});
    }, LIST_COALESCE_MS);
  }, []);

  useEffect(() => {
    // Quiet on failure: an empty picker is its own signal.
    api
      .models()
      .then((r) => useStore.getState().setModels(r.models))
      .catch(() => {});
    api
      .agents()
      .then((r) => useStore.getState().setAgents(r.agents, r.defaultAgentId))
      .catch(() => {});
    // The auth probe fetched the list already; this covers the other way in, a
    // fresh login, where nothing has.
    if (useStore.getState().sessions.length === 0) refreshSessions();
  }, []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  // The cookie is already invalid, so drop the session and show the gate rather
  // than looping on reconnects.
  const handleUnauthorized = useCallback(() => {
    closeSocket();
    useStore.getState().clearActive();
    onLock();
  }, [closeSocket, onLock]);

  // The file panel declares which directories it is showing, and the server
  // watches exactly those. Resent on reconnect, since watches live with the
  // connection rather than the session.
  const watchedPaths = useStore((s) => s.watchedPaths);
  useEffect(() => {
    if (connStatus !== 'connected') return;
    socketRef.current?.watchPaths(watchedPaths);
  }, [watchedPaths, connStatus]);

  const openSession = useCallback(
    // `adopted` is a detail already in hand, from creating the session: there is nothing
    // to fetch, and no "Opening session" state to show, which is what made the draft
    // look like it reloaded the page.
    async (id: string, adopted?: Awaited<ReturnType<typeof api.getSession>>) => {
      if (useStore.getState().activeId === id) return;
      openTarget.current = id;
      closeSocket();
      setConnStatus('connecting');
      if (!adopted) useStore.getState().setLoadingSession(id);

      let detail: Awaited<ReturnType<typeof api.getSession>>;
      if (adopted) detail = adopted;
      else
      try {
        detail = await api.getSession(id);
      } catch (err) {
        if (openTarget.current !== id) return;
        // Fetch failed (network, or the session was deleted): don't strand the
        // UI in "connecting" - reset and surface the error.
        setConnStatus('closed');
        useStore.getState().setLoadingSession(null);
        console.error('open session failed:', err);
        // Replaced, so a refresh doesn't retry it and back doesn't return to it.
        navigate('/', { replace: true });
        return;
      }
      // Abandoned while fetching: leave whatever the user moved on to alone.
      if (openTarget.current !== id) return;
      useStore.getState().loadDetail(detail, { keepPending: Boolean(adopted) });

      const socket = new SessionSocket(
        id,
        {
          onEvent: (e) => {
            useStore.getState().applyEvent(e);
            // A first turn is when the server names an unnamed session, so pick the list
            // up now instead of leaving the row untitled until the turn ends.
            if (e.payload.kind === 'turn_started') refreshSessions();
            // kiro persists the session around now, so reconcile the list for its
            // real updatedAt, title and credits. Delayed until that settles.
            if (e.payload.kind === 'turn_ended') {
              setTimeout(refreshSessions, 1200);
            }
          },
          onStatus: setConnStatus,
          onResync: async () => {
            const fresh = await api.getSession(id);
            if (openTarget.current !== id) return;
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
          onFsChanged: (path) => useStore.getState().bumpFsPath(path),
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
    [closeSocket, handleUnauthorized, navigate, refreshSessions],
  );

  const backToList = useCallback(() => navigate('/'), [navigate]);

  // Marked before the route changes, or the pane flashes back to the list.
  // Not for the open session: the route wouldn't change, so nothing clears it.
  const markLoading = useCallback((id: string) => {
    if (id === useStore.getState().activeId) return;
    useStore.getState().setLoadingSession(id);
  }, []);


  // The route owns which session is open, so cold loads, back/forward and clicks all arrive
  // here. The ref fires it on URL changes rather than renders.
  const openTarget = useRef<string | null>(null);

  const handledRoute = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (handledRoute.current === routeSessionId) return;
    handledRoute.current = routeSessionId;
    if (routeSessionId) {
      void openSession(routeSessionId);
    } else {
      openTarget.current = null;
      closeSocket();
      useStore.getState().clearActive();
      refreshSessions();
    }
    // Deliberately not the store object: it changes on every update, and a re-run
    // between claiming a route and the navigation landing would unclaim it and reopen
    // the session from scratch.
  }, [routeSessionId, openSession, closeSocket, refreshSessions]);

  const createSession = useCallback(
    async (opts: CreateOpts) => {
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
          // No directory named: the session gets one of its own.
          freshWorkspace: !opts.cwd,
        });
        refreshSessions();
        const id = detail.summary.sessionId;
        // Claim the route before navigating, so the effect that opens sessions leaves
        // this one alone: it is already open, with the prompt that created it on screen.
        handledRoute.current = id;
        navigate(pathForSession(id));
        void openSession(id, detail);
        return true;
      } catch (err) {
        // Keep the user on the chat pane and show what went wrong; `creating`
        // stays true so `hasActive` holds the view open for the error screen.
        setConnStatus('closed');
        setCreateError(err instanceof Error ? err.message : 'Failed to create session');
        return false;
      } finally {
        setCreating(false);
      }
    },
    [closeSocket, navigate, openSession, refreshSessions],
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
      if (useStore.getState().activeId === id) backToList();
      else refreshSessions();
    },
    [backToList, refreshSessions],
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

  // A new session costs nothing until there is something to say: the chat opens on a
  // draft route, and the first prompt is what creates the session.
  const startDraft = useCallback(() => {
    openTarget.current = null;
    closeSocket();
    useStore.getState().clearActive();
    setCreateError(null);
    navigate(DRAFT_PATH);
  }, [closeSocket, navigate]);

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
      if (isDraft) {
        // Create on demand, then deliver: the socket opens as part of going to the
        // new session, so the prompt waits for it rather than being dropped.
        // The pickers are live in a draft, so it is created with whatever they show.
        const { currentModeId, currentModelId } = useStore.getState();
        void createSession({
          agentId: currentModeId,
          modelId: currentModelId,
          // Named on creation, so the row never appears as "Untitled session" for the
          // moment between the session existing and its first turn starting.
          title: titleFromPrompt(content),
        }).then((created) => {
          if (created) firstPromptRef.current = { id, content };
          else useStore.getState().markPendingFailed(id, 'Could not start the session.');
        });
        return;
      }
      sendMessage(id, content);
    },
    [createSession, isDraft, sendMessage],
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
    useStore.getState().clearActive();
    navigate('/', { replace: true });
    onLock();
  }, [closeSocket, navigate, onLock]);

  // Lets a widget send a message as the user. Registered here because this is
  // where the socket lives.
  useEffect(() => {
    setPromptSender((text) => send([{ type: 'text', text }]));
    return () => setPromptSender(null);
  }, [send]);

  // The prompt that created the session, delivered once there is a socket for it.
  useEffect(() => {
    const held = firstPromptRef.current;
    if (!held || connStatus !== 'connected') return;
    firstPromptRef.current = null;
    sendMessage(held.id, held.content);
  }, [connStatus, sendMessage]);

  // Mobile shows one pane at a time and the list is home, so landing on the default
  // draft must not push the chat over it - only an explicit new-session tap does.
  const hasActive =
    isDraftRoute ||
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
        onNew={startDraft}
        onDelete={deleteSession}
        onRename={renameSession}
        onLock={lock}
      />
      <ChatPane
        isDraft={isDraft}
        loadingSessionId={store.loadingSessionId}
        connStatus={connStatus}
        createError={createError}
        onRetryCreate={retryCreate}
        onDismissError={dismissCreateError}
        onBack={backToList}
        onSend={send}
        onRetry={retrySend}
        onRetryTurn={retryTurn}
        onCancel={cancel}
        onChangeModel={changeModel}
        onChangeAgent={changeAgent}
        onCompact={compact}
      />
    </div>
  );
}
