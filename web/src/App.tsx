import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useMatch, useNavigate } from 'react-router';
import { useStore } from './state/store.js';
import { api, logout } from './api/rest.js';
import { sessionController } from './state/sessionController.js';
import { Sidebar } from './components/layout/Sidebar.js';
import { ChatPane } from './components/layout/ChatPane.js';
import { TokenGate } from './components/common/TokenGate.js';
import { SESSION_ROUTE } from './util/route.js';

type AuthState = 'checking' | 'gate' | 'ready';

/** Matches the stylesheet's breakpoint: under this the panel is a drawer over the chat. */
const MOBILE_MAX = 768;

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

/**
 * Sidebar beside the chat on desktop, one pane at a time on mobile.
 *
 * Renders and routes; every session action belongs to sessionController. Narrow
 * selectors, not the whole store: streaming mutates streamingText on every chunk,
 * and this renders both panes.
 */
function Shell({ onLock }: { onLock: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const loadingSessionId = useStore((s) => s.loadingSessionId);
  const connStatus = useStore((s) => s.connStatus);
  const createError = useStore((s) => s.createError);
  const watchedPaths = useStore((s) => s.watchedPaths);
  const navigate = useNavigate();
  // Not useParams: the param belongs to the child route, so it isn't visible here.
  const matchedId = useMatch(SESSION_ROUTE)?.params.sessionId ?? null;
  // A draft is a session that does not exist yet: the chat opens immediately and the first
  // prompt creates it. Both the explicit /sessions/new route and the default page, so
  // landing with nothing open puts you in front of a composer.
  const isDraftRoute = matchedId === 'new';
  const isDraft = isDraftRoute || (!matchedId && activeId === null);
  const routeSessionId = isDraft ? null : matchedId;

  // The two things only React can do. Re-attached rather than set once, because
  // navigate's identity changes with the router's state.
  useEffect(() => {
    sessionController.attach({ navigate, onLock });
  }, [navigate, onLock]);

  useEffect(() => {
    sessionController.loadPickers();
    // The auth probe fetched the list already; this covers the other way in, a
    // fresh login, where nothing has.
    if (useStore.getState().sessions.length === 0) sessionController.refreshSessions();
  }, []);

  // The route owns which session is open, so cold loads, back/forward and clicks
  // all arrive here.
  useEffect(() => {
    sessionController.syncRoute(routeSessionId, isDraft);
  }, [routeSessionId, isDraft]);

  useEffect(() => {
    if (connStatus !== 'connected') return;
    sessionController.watchPaths(watchedPaths);
  }, [watchedPaths, connStatus]);

  // Lock the app: clear the session cookie server-side, then tear everything down.
  const lock = useCallback(() => {
    void logout();
    sessionController.lock();
  }, []);

  // Mobile shows one pane at a time and the list is home, so landing on the default
  // draft must not push the chat over it - only an explicit new-session tap does.
  // The panel is a column beside the chat where there is room, and a drawer over it where
  // there is not. Either way, the chat is what you land on.
  const [navOpen, setNavOpen] = useState(() => window.innerWidth > MOBILE_MAX);
  const closeNavOnMobile = useCallback(() => {
    if (window.innerWidth <= MOBILE_MAX) setNavOpen(false);
  }, []);

  return (
    <div className={`layout ${navOpen ? 'nav-open' : ''}`}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        loadingId={loadingSessionId}
        onOpen={(id) => {
          sessionController.markLoading(id);
          closeNavOnMobile();
        }}
        onNew={() => {
          sessionController.startDraft();
          closeNavOnMobile();
        }}
        onDelete={(id) => void sessionController.deleteSession(id)}
        onRename={(id, title) => void sessionController.renameSession(id, title)}
        onLock={lock}
      />
      {/* Only the drawer needs dismissing; a wide screen gives the panel its own column. */}
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
        loadingSessionId={loadingSessionId}
        connStatus={connStatus}
        createError={createError}
        onRetryCreate={() => sessionController.retryCreate()}
        onDismissError={() => sessionController.dismissCreateError()}
        onSend={(content) => sessionController.send(content)}
        onRetry={(id, text) => sessionController.retrySend(id, text)}
        onRetryTurn={(text) => sessionController.retryTurn(text)}
        onCancel={() => sessionController.cancel()}
        onChangeModel={(id) => sessionController.changeModel(id)}
        onChangeAgent={(id) => sessionController.changeAgent(id)}
        onCompact={() => sessionController.compact()}
        onReload={() => void sessionController.reloadSession()}
      />
    </div>
  );
}
