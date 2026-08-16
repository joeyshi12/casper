import { useState, useEffect } from 'react';
import type { PromptContentBlock } from '@casper/shared';
import { useStore } from '../../state/store.js';
import type { ConnStatus } from '../../api/SessionSocket.js';
import { Transcript } from '../chat/Transcript.js';
import { FileTree } from '../chat/FileTree.js';
import { Composer } from '../chat/Composer.js';
import { ConnDot } from '../common/ConnBanner.js';
import { Spinner, FilesIcon } from '../common/icons.js';

interface Props {
  /** A session being composed: no id yet, created by the first prompt. */
  isDraft: boolean;
  /** Session whose detail is being fetched (switching sessions), distinct from
   *  the currently-loaded one so we don't render its stale transcript while
   *  waiting on a slow hydrate. */
  loadingSessionId: string | null;
  connStatus: ConnStatus;
  createError: string | null;
  onRetryCreate: () => void;
  onDismissError: () => void;
  onBack: () => void;
  onSend: (content: PromptContentBlock[]) => void;
  onRetry: (id: string, text: string) => void;
  /** Re-send a prompt after a failed turn. */
  onRetryTurn: (text: string) => void;
  onCancel: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeAgent: (modeId: string) => void;
  onCompact: () => void;
}

/** The right-hand chat area. Shows an empty prompt when no session is open. */
export function ChatPane({
  isDraft,
  loadingSessionId,
  connStatus,
  createError,
  onRetryCreate,
  onDismissError,
  onBack,
  onSend,
  onRetry,
  onRetryTurn,
  onCancel,
  onChangeModel,
  onChangeAgent,
  onCompact,
}: Props) {
  const title = useStore((s) => s.sessions.find((x) => x.sessionId === s.activeId)?.title);
  // The hero belongs to an empty draft: sending hands over to the transcript at once, so the
  // message shows while the session is still being created.
  const composing = useStore((st) => isDraft && st.pending.length === 0 && st.items.length === 0);
  const activeId = useStore((s) => s.activeId);
  const sessionNotice = useStore((s) => s.sessionNotice);
  const dismissSessionNotice = useStore((s) => s.dismissSessionNotice);
  const [showTree, setShowTree] = useState(false);

  // The panel belongs to the session it was opened in. Without this it survives a
  // switch as component state, and a new session pops it open the moment the first
  // prompt gives that session an id.
  useEffect(() => {
    setShowTree(false);
  }, [activeId]);

  // Switching sessions: the detail is still being fetched. Checked before the main branch
  // so a slow hydrate doesn't leave the previous session's transcript on screen under a new
  // header, which reads as the click having done nothing.
  if (loadingSessionId) {
    return (
      <main className="chatpane">
        <header className="chat-head">
          <button className="backbtn" onClick={onBack} aria-label="Back to sessions">
            ‹
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
          <button className="backbtn" onClick={onBack} aria-label="Back to sessions">
            ‹
          </button>
          <span className="chat-title">New session</span>
        </header>
        <div className="chat-blank">
          <p className="chat-blank-title">Couldn't start the session</p>
          <p className="chat-blank-sub">{createError}</p>
          <div className="chat-error-actions">
            <button className="btn-primary" onClick={onRetryCreate}>
              Try again
            </button>
            <button className="btn-ghost" onClick={onDismissError}>
              Back to sessions
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Prompt, then a single bar: config on the left, live stats on the right.
  const composer = (
    <div className="composer-wrap">
      {sessionNotice && (
        <div className="notice-banner" role="alert">
          <span className="notice-icon" aria-hidden>
            ⚠
          </span>
          <div className="notice-text">
            <p className="notice-title">{sessionNotice.title}</p>
            {sessionNotice.fix && <p className="notice-sub">{sessionNotice.fix}</p>}
          </div>
          <button
            className="notice-x"
            onClick={dismissSessionNotice}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <Composer
        sessionId={activeId}
        onSend={onSend}
        onCancel={onCancel}
        onCompact={onCompact}
        onChangeModel={onChangeModel}
        onChangeAgent={onChangeAgent}
        connStatus={connStatus}
        draft={isDraft}
      />
    </div>
  );

  // A draft has no transcript, so the wordmark and the prompt sit together in the middle,
  // the way a new chat reads before anything has been said.
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
        <Transcript onRetry={onRetry} onRetryTurn={onRetryTurn} />
      </div>
      {composer}
    </>
  );

  return (
    <main className={`chatpane chatpane-split ${showTree ? 'has-tree' : ''}`}>
      <div className="chat-col">
        <header className="chat-head">
          <button className="backbtn" onClick={onBack} aria-label="Back to sessions">
            ‹
          </button>
          {/* In a draft the hero below carries the name, so the bar stays empty. */}
          {!isDraft && (
            <span className="chat-title" title={title}>
              {title ?? 'Session'}
            </span>
          )}
          {/* A draft has no socket yet, so a red "Offline" dot would be a lie. */}
          {!isDraft && <ConnDot status={connStatus} />}
          {/* A draft has no workspace yet, so there is nothing to browse. */}
          {!isDraft && (
            <button
              className={`ftree-toggle ${showTree ? 'is-active' : ''}`}
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
          {showTree && <FileTree sessionId={activeId} onClose={() => setShowTree(false)} />}
        </aside>
      )}
      {/* Mobile: tapping outside the drawer closes it (the header toggle is
          covered by the panel on small screens). */}
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
