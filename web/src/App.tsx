import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from './state/store.js';
import { api, getToken } from './api/rest.js';
import { SessionSocket, type ConnStatus } from './api/SessionSocket.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ChatPane } from './components/layout/ChatPane.js';
import { NewSessionSheet } from './components/sessions/NewSessionSheet.js';
import { TokenGate } from './components/common/TokenGate.js';

export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) return;
    api
      .listSessions()
      .then(() => setReady(true))
      .catch(() => setReady(false));
  }, []);

  if (!ready) return <TokenGate onReady={() => setReady(true)} />;
  return <Shell />;
}

/**
 * Responsive shell, modeled on Happy's web layout: a persistent session sidebar
 * beside the chat on desktop, collapsing to a one-screen-at-a-time flow on
 * mobile. `has-active` drives which pane is visible on narrow screens.
 */
function Shell() {
  const store = useStore();
  const [newOpen, setNewOpen] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>('closed');
  const socketRef = useRef<SessionSocket | null>(null);

  const refreshSessions = useCallback(() => {
    api.listSessions().then((r) => store.setSessions(r.sessions)).catch(() => {});
  }, [store]);

  useEffect(() => {
    api.models().then((r) => store.setModels(r.models)).catch(() => {});
    api.agents().then((r) => store.setAgents(r.agents)).catch(() => {});
    refreshSessions();
    const poll = setInterval(refreshSessions, 8000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeSocket = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

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
        },
        detail.head,
      );
      socketRef.current = socket;
      socket.connect();
    },
    [closeSocket, store],
  );

  const backToList = useCallback(() => {
    closeSocket();
    store.clearActive();
    refreshSessions();
  }, [closeSocket, refreshSessions, store]);

  const createSession = useCallback(
    async (opts: { cwd: string; agentId: string; modelId: string }) => {
      setNewOpen(false);
      const detail = await api.createSession({
        cwd: opts.cwd || undefined,
        agentId: opts.agentId,
        modelId: opts.modelId,
      });
      refreshSessions();
      await openSession(detail.summary.sessionId);
    },
    [openSession, refreshSessions],
  );

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

  const send = useCallback((text: string) => {
    socketRef.current?.prompt([{ type: 'text', text }]);
  }, []);
  const cancel = useCallback(() => socketRef.current?.cancel(), []);
  const changeModel = useCallback((modelId: string) => {
    socketRef.current?.setModel(modelId);
    useStore.setState({ currentModelId: modelId });
  }, []);
  const changeAgent = useCallback((modeId: string) => {
    socketRef.current?.setMode(modeId);
    useStore.setState({ currentModeId: modeId });
  }, []);

  const hasActive = store.activeId !== null;

  return (
    <div className={`layout ${hasActive ? 'has-active' : ''}`}>
      <Sidebar
        sessions={store.sessions}
        activeId={store.activeId}
        onOpen={openSession}
        onNew={() => setNewOpen(true)}
        onDelete={deleteSession}
        onRename={renameSession}
      />
      <ChatPane
        hasActive={hasActive}
        connStatus={connStatus}
        onBack={backToList}
        onSend={send}
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
