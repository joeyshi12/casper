import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router';
import { useStore } from './state/store.js';
import { api, logout } from './api/rest.js';
import { sessionController } from './state/sessionController.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ChatPane } from './components/layout/ChatPane.js';
import { TokenGate } from './components/common/TokenGate.js';
import { CHAT_ROUTE, DRAFT_PATH } from './util/route.js';

type AuthState = 'checking' | 'gate' | 'ready';

const MOBILE_MAX = 768;

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    if (auth !== 'checking') return;
    api
      .listChats()
      .then((r) => {
        useStore.getState().setChats(r.chats);
        setAuth('ready');
      })
      .catch(() => setAuth('gate'));
  }, [auth]);

  if (auth === 'checking') return <div className="app-splash" />;
  if (auth === 'gate') return <TokenGate onReady={() => setAuth('ready')} />;
  return (
    <BrowserRouter>
      <Routes>
        {/* A layout route, so navigating doesn't remount Shell and drop the socket. */}
        <Route element={<Shell onLock={() => setAuth('gate')} />}>
          <Route index element={null} />
          <Route path={DRAFT_PATH} element={null} />
          <Route path={CHAT_ROUTE} element={null} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

/**
 * Sidebar beside the chat on desktop, one pane at a time on mobile. Narrow
 * selectors, not the whole store: streaming mutates streamingText on every
 * chunk, and this renders both panes.
 */
function Shell({ onLock }: { onLock: () => void }) {
  const sessions = useStore((s) => s.chats);
  const activeId = useStore((s) => s.activeId);
  const watchedPaths = useStore((s) => s.watchedPaths);
  const connStatus = useStore((s) => s.connStatus);
  const loadingChatId = useStore((s) => s.loadingChatId);
  const navigate = useNavigate();
  // useMatch, not useParams: the param belongs to the child route, invisible here.
  const matchedId = useMatch(CHAT_ROUTE)?.params.chatId ?? null;
  const isDraft = useMatch(DRAFT_PATH) !== null || (!matchedId && activeId === null);

  // Re-attached rather than set once: navigate's identity changes with router state.
  useEffect(() => {
    sessionController.attach({ navigate, onLock });
  }, [navigate, onLock]);

  useEffect(() => {
    sessionController.loadPickers();
    // Covers a fresh login; the auth probe already fetched the list otherwise.
    if (useStore.getState().chats.length === 0) sessionController.refreshSessions();
  }, []);

  useEffect(() => {
    sessionController.syncRoute(matchedId, isDraft);
  }, [matchedId, isDraft]);

  useEffect(() => {
    if (connStatus !== 'connected') return;
    sessionController.watchPaths(watchedPaths);
  }, [watchedPaths, connStatus]);

  const lock = useCallback(() => {
    void logout();
    sessionController.lock();
  }, []);

  const [navOpen, setNavOpen] = useState(() => window.innerWidth > MOBILE_MAX);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const onChange = (e: MediaQueryListEvent) => setNavOpen(!e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const closeNavOnMobile = useCallback(() => {
    if (window.innerWidth <= MOBILE_MAX) setNavOpen(false);
  }, []);

  return (
    <div className={`layout ${navOpen ? 'nav-open' : ''}`}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        loadingId={loadingChatId}
        onOpen={(id) => {
          sessionController.markLoading(id);
          closeNavOnMobile();
        }}
        onNew={() => {
          sessionController.startDraft();
          closeNavOnMobile();
        }}
        onDelete={(id) => void sessionController.deleteChat(id)}
        onRename={(id, title) => void sessionController.renameChat(id, title)}
        onLock={lock}
      />
      {navOpen && (
        <button
          className="nav-scrim"
          aria-label="Close session panel"
          onClick={() => setNavOpen(false)}
        />
      )}
      <ChatPane
        navOpen={navOpen}
        onToggleNav={() => setNavOpen((o) => !o)}
        isDraft={isDraft}
      />
    </div>
  );
}
