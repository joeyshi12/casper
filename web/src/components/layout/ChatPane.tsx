import { useState } from 'react';
import type { PromptContentBlock } from '@casper/shared';
import { useStore } from '../../state/store.js';
import type { ConnStatus } from '../../api/SessionSocket.js';
import { Transcript } from '../chat/Transcript.js';
import { FileTree } from '../chat/FileTree.js';
import { Composer } from '../chat/Composer.js';
import { ObservabilityPanel } from '../observability/ObservabilityPanel.js';
import { ModelPicker, AgentPicker } from '../controls/Pickers.js';
import { ConnDot } from '../common/ConnBanner.js';
import { Spinner, FilesIcon } from '../common/icons.js';

interface Props {
  hasActive: boolean;
  connStatus: ConnStatus;
  creating: boolean;
  createError: string | null;
  onRetryCreate: () => void;
  onDismissError: () => void;
  onBack: () => void;
  onSend: (content: PromptContentBlock[]) => void;
  onRetry: (id: string, text: string) => void;
  onCancel: () => void;
  onNew: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeAgent: (modeId: string) => void;
}

/** The right-hand chat area. Shows an empty prompt when no session is open. */
export function ChatPane({
  hasActive,
  connStatus,
  creating,
  createError,
  onRetryCreate,
  onDismissError,
  onBack,
  onSend,
  onRetry,
  onCancel,
  onNew,
  onChangeModel,
  onChangeAgent,
}: Props) {
  const currentModeId = useStore((s) => s.currentModeId);
  const currentModelId = useStore((s) => s.currentModelId);
  const title = useStore((s) => s.sessions.find((x) => x.sessionId === s.activeId)?.title);
  const activeId = useStore((s) => s.activeId);
  const [showTree, setShowTree] = useState(false);

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
    <main className={`chatpane ${showTree ? 'has-tree' : ''}`}>
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
        <Transcript onRetry={onRetry} />

        {activeId && (
          <aside className={`ftree-aside ${showTree ? 'is-open' : ''}`}>
            {showTree && <FileTree sessionId={activeId} />}
          </aside>
        )}
      </div>

      {/* Prompt, then a single bar: config on the left, live stats on the right. */}
      <div className="composer-wrap">
        <Composer onSend={onSend} onCancel={onCancel} live={connStatus === 'connected'} />
        <div className="composer-bar">
          <div className="composer-tools">
            <AgentPicker value={currentModeId} onChange={onChangeAgent} />
            <ModelPicker value={currentModelId} onChange={onChangeModel} />
          </div>
          <ObservabilityPanel />
        </div>
      </div>
    </main>
  );
}
