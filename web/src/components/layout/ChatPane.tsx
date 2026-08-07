import { useState } from 'react';
import type { PromptContentBlock } from '@casper/shared';
import { useStore } from '../../state/store.js';
import type { ConnStatus } from '../../api/SessionSocket.js';
import { Transcript } from '../chat/Transcript.js';
import { FileTree } from '../chat/FileTree.js';
import { Composer } from '../chat/Composer.js';
import { ConnDot } from '../common/ConnBanner.js';
import { Spinner, FilesIcon } from '../common/icons.js';

interface Props {
  hasActive: boolean;
  /** Session whose detail is being fetched (switching sessions), distinct from
   *  the currently-loaded one so we don't render its stale transcript while
   *  waiting on a slow hydrate. */
  loadingSessionId: string | null;
  connStatus: ConnStatus;
  creating: boolean;
  createError: string | null;
  onRetryCreate: () => void;
  onDismissError: () => void;
  onBack: () => void;
  onSend: (content: PromptContentBlock[]) => void;
  onRetry: (id: string, text: string) => void;
  /** Re-send a prompt after a failed turn. */
  onRetryTurn: (text: string) => void;
  onCancel: () => void;
  onNew: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeAgent: (modeId: string) => void;
  onCompact: () => void;
}

/** The right-hand chat area. Shows an empty prompt when no session is open. */
export function ChatPane({
  hasActive,
  loadingSessionId,
  connStatus,
  creating,
  createError,
  onRetryCreate,
  onDismissError,
  onBack,
  onSend,
  onRetry,
  onRetryTurn,
  onCancel,
  onNew,
  onChangeModel,
  onChangeAgent,
  onCompact,
}: Props) {
  const title = useStore((s) => s.sessions.find((x) => x.sessionId === s.activeId)?.title);
  const activeId = useStore((s) => s.activeId);
  const sessionNotice = useStore((s) => s.sessionNotice);
  const dismissSessionNotice = useStore((s) => s.dismissSessionNotice);
  const [showTree, setShowTree] = useState(false);

  // Switching to a different session: its detail (transcript, mode, etc.) is
  // still being fetched. Checked before the main branch below so we don't keep
  // rendering the previous session's transcript under its old header while a
  // slow hydrate (large transcripts re-parse their full history on open) is in
  // flight - that reads as the click having done nothing.
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

  if (!hasActive) {
    return (
      <main className="chatpane">
        <div className="chat-blank">
          <p className="chat-blank-title">Pick a session</p>
          <p className="chat-blank-sub">
            Choose one on the left, or start a new one. Casper keeps working even
            after you close the app.
          </p>
          <button className="btn-primary" onClick={onNew}>
            New session
          </button>
        </div>
      </main>
    );
  }

  if (creating) {
    return (
      <main className="chatpane">
        <header className="chat-head">
          <span className="chat-title">New session</span>
        </header>
        <div className="chat-blank">
          <Spinner size={32} className="chat-spinner" />
          <p className="chat-blank-title">Starting session</p>
          <p className="chat-blank-sub">
            Spinning up Kiro and connecting. This can take a few seconds.
          </p>
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

  return (
    <main className={`chatpane chatpane-split ${showTree ? 'has-tree' : ''}`}>
      <div className="chat-col">
        <header className="chat-head">
          <button className="backbtn" onClick={onBack} aria-label="Back to sessions">
            ‹
          </button>
          <span className="chat-title" title={title}>
            {title ?? 'Session'}
          </span>
          <ConnDot status={connStatus} />
          <button
            className={`ftree-toggle ${showTree ? 'is-active' : ''}`}
            onClick={() => setShowTree((v) => !v)}
            title="Toggle file tree"
            aria-label="Toggle file tree"
            aria-pressed={showTree}
          >
            <FilesIcon size={18} />
          </button>
        </header>

        <div className="chat-body">
          <Transcript onRetry={onRetry} onRetryTurn={onRetryTurn} />
        </div>

        {/* Prompt, then a single bar: config on the left, live stats on the right. */}
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
          />
        </div>
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
