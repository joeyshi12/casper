import { useStore } from '../../state/store.js';
import type { ConnStatus } from '../../api/SessionSocket.js';
import { Transcript } from '../chat/Transcript.js';
import { Composer } from '../chat/Composer.js';
import { ObservabilityPanel } from '../observability/ObservabilityPanel.js';
import { ModelPicker, AgentPicker } from '../controls/Pickers.js';
import { ConnDot } from '../common/ConnBanner.js';

interface Props {
  hasActive: boolean;
  connStatus: ConnStatus;
  onBack: () => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  onNew: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeAgent: (modeId: string) => void;
}

/** The right-hand chat area. Shows an empty prompt when no session is open. */
export function ChatPane({
  hasActive,
  connStatus,
  onBack,
  onSend,
  onCancel,
  onNew,
  onChangeModel,
  onChangeAgent,
}: Props) {
  const currentModeId = useStore((s) => s.currentModeId);
  const currentModelId = useStore((s) => s.currentModelId);
  const title = useStore((s) => s.sessions.find((x) => x.sessionId === s.activeId)?.title);

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

  return (
    <main className="chatpane">
      <header className="chat-head">
        <button className="backbtn" onClick={onBack} aria-label="Back to sessions">
          ‹
        </button>
        <span className="chat-title" title={title}>
          {title ?? 'Session'}
        </span>
        <ConnDot status={connStatus} />
      </header>

      <Transcript />

      {/* Prompt, then a single bar: config on the left, live stats on the right. */}
      <div className="composer-wrap">
        <Composer onSend={onSend} onCancel={onCancel} />
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
