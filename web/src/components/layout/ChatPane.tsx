import { useState, useEffect } from 'react';
import { useStore } from '../../state/store.js';
import { sessionController } from '../../state/sessionController.js';
import { Transcript } from '../chat/Transcript.js';
import { FileTree } from '../chat/FileTree.js';
import { FilePreview } from '../chat/FilePreview.js';
import { Composer } from '../chat/Composer.js';
import { ConnDot } from '../common/ConnBanner.js';
import { Spinner, FilesIcon, MenuIcon, RefreshIcon, WarningIcon, CloseIcon } from '../common/icons.js';

interface Props {
  isDraft: boolean;
  navOpen: boolean;
  onToggleNav: () => void;
}

export function ChatPane({ isDraft, navOpen, onToggleNav }: Props) {
  const loadingChatId = useStore((s) => s.loadingChatId);
  const connStatus = useStore((s) => s.connStatus);
  const createError = useStore((s) => s.createError);
  const title = useStore((s) => s.chats.find((x) => x.chatId === s.activeId)?.title);
  const composing = useStore((st) => isDraft && st.pending.length === 0 && st.items.length === 0);
  const activeId = useStore((s) => s.activeId);
  const chatId = useStore((s) => s.chatId);
  const chatNotice = useStore((s) => s.chatNotice);
  const reloading = useStore((s) => s.reloadingId !== null && s.reloadingId === s.activeId);
  const turnRunning = useStore((s) => s.observability.turnStatus === 'running');
  const dismissChatNotice = useStore((s) => s.dismissChatNotice);
  const [showTree, setShowTree] = useState(false);

  // Tied to the session: without this a switch keeps the panel open as component
  // state, and a new session pops it open as soon as the first prompt gives it an id.
  useEffect(() => {
    setShowTree(false);
  }, [activeId]);

  // Checked before the main branch, so a slow hydrate doesn't leave the previous
  // session's transcript on screen under the new header.
  if (loadingChatId) {
    return (
      <main className="chatpane">
        <header className="chat-head">
          <button
            className="navbtn"
            onClick={onToggleNav}
            aria-label={navOpen ? 'Hide sessions' : 'Show sessions'}
            aria-expanded={navOpen}
          >
            <MenuIcon size={20} />
          </button>
          <span className="chat-title">Opening session…</span>
        </header>
        <div className="chat-blank">
          <Spinner size={48} className="chat-spinner" />
        </div>
      </main>
    );
  }

  if (createError) {
    return (
      <main className="chatpane">
        <header className="chat-head">
          <button
            className="navbtn"
            onClick={onToggleNav}
            aria-label={navOpen ? 'Hide sessions' : 'Show sessions'}
            aria-expanded={navOpen}
          >
            <MenuIcon size={20} />
          </button>
          <span className="chat-title">New session</span>
        </header>
        <div className="chat-blank">
          <p className="chat-blank-title">Couldn't start the session</p>
          <p className="chat-blank-sub">{createError}</p>
          <div className="chat-error-actions">
            <button className="btn-primary" onClick={() => sessionController.retryCreate()}>
              Try again
            </button>
            <button className="btn-ghost" onClick={() => sessionController.dismissCreateError()}>
              Back to sessions
            </button>
          </div>
        </div>
      </main>
    );
  }

  const notice = chatNotice && (
    <div className="notice-banner" role="alert">
      <WarningIcon size={16} className="notice-icon" />
      <div className="notice-text">
        <p className="notice-title">{chatNotice.title}</p>
        {chatNotice.fix && <p className="notice-sub">{chatNotice.fix}</p>}
      </div>
      <button
        className="notice-x"
        onClick={dismissChatNotice}
        aria-label="Dismiss"
      >
        <CloseIcon size={14} />
      </button>
    </div>
  );

  const composer = (
    <div className="composer-wrap">
      {notice}
      <Composer
        chatId={chatId}
        connStatus={connStatus}
        draft={isDraft}
      />
    </div>
  );

  const draftBody = (
    <div className="chat-draft">
      <div className="draft-hero">
        <img className="draft-logo" src="/logo.svg" alt="" />
        <h1 className="draft-title">Casper</h1>
      </div>
      {composer}
    </div>
  );

  const sessionBody = (
    <>
      <div className="chat-body">
        <Transcript />
      </div>
      {composer}
    </>
  );

  return (
    <main className={`chatpane chatpane-split ${showTree ? 'has-tree' : ''}`}>
      <div className="chat-col">
        <header className="chat-head">
          <button
            className="navbtn"
            onClick={onToggleNav}
            aria-label={navOpen ? 'Hide sessions' : 'Show sessions'}
            aria-expanded={navOpen}
          >
            <MenuIcon size={20} />
          </button>
          {!isDraft && (
            <span className="chat-title" title={title}>
              {title ?? 'Session'}
            </span>
          )}
          {!isDraft && <ConnDot status={connStatus} />}
          {!isDraft && (
            <button
              className="chat-head-btn chat-reload"
              onClick={() => void sessionController.reloadChat()}
              disabled={reloading || turnRunning}
              title={turnRunning ? 'Reload after the turn' : 'Reload session'}
              aria-label="Reload session"
            >
              {reloading ? <Spinner size={18} /> : <RefreshIcon size={18} />}
            </button>
          )}
          {!isDraft && (
            <button
              className={`chat-head-btn ftree-toggle ${showTree ? 'is-active' : ''}`}
              onClick={() => setShowTree((v) => !v)}
              title="Toggle file tree"
              aria-label="Toggle file tree"
              aria-pressed={showTree}
            >
              <FilesIcon size={18} />
            </button>
          )}
        </header>

        {composing ? draftBody : sessionBody}
      </div>

      {activeId && (
        <aside className={`ftree-aside ${showTree ? 'is-open' : ''}`}>
          {showTree && <FileTree chatId={activeId} onClose={() => setShowTree(false)} />}
          <FilePreview />
        </aside>
      )}
      {activeId && showTree && (
        <div
          className="ftree-backdrop"
          onClick={() => setShowTree(false)}
          aria-hidden
        />
      )}
    </main>
  );
}
